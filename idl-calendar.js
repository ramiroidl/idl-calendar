const DAY_FORMAT = { weekday: "short", month: "short", day: "numeric" };

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarRange(days, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { start, end };
}

export function monthRange(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return { start, end };
}

export function eventsForDay(events, day) {
  const { start, end } = calendarRange(1, day);
  return events.filter((event) => event.start < end && event.end > start);
}

function eventDate(value) {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return dateKey(date) === value ? date : null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeEvent(event, calendar) {
  if (!event || typeof event !== "object") return null;
  const value = typeof event.start === "string"
    ? event.start
    : event.start?.dateTime ?? event.start?.date;
  const endValue = typeof event.end === "string"
    ? event.end
    : event.end?.dateTime ?? event.end?.date;
  const start = eventDate(value);
  const end = eventDate(endValue);
  if (!start || !end || end <= start) return null;
  return {
    start,
    end,
    allDay: /^\d{4}-\d{2}-\d{2}$/.test(value),
    summary: typeof event.summary === "string" ? event.summary : "Untitled event",
    calendar,
  };
}

export function sortEvents(events) {
  return events.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay)
    || a.summary.localeCompare(b.summary));
}

export class IdlCalendar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._events = [];
    this._request = 0;
    this._loading = true;
    this._error = "";
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; color: #000; background: #fff; }
        ha-card {
          display: block; box-sizing: border-box; padding: 20px; background: #fff; color: #000;
          border: 2px solid #000; border-radius: 0; box-shadow: none;
          font-family: Arial, sans-serif; font-size: 18px; line-height: 1.3;
        }
        header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 20px;
          justify-content: space-between; border-bottom: 3px solid #000; padding-bottom: 10px; }
        h1 { font-size: 26px; margin: 0; }
        h2 { font-size: 18px; margin: 16px 0 4px; border-bottom: 1px solid #000; }
        ul { list-style: none; margin: 0; padding: 0; }
        li { padding: 5px 0; break-inside: avoid; }
        .summary { font-weight: bold; overflow-wrap: anywhere; }
        #status { margin: 12px 0 0; }
        #status:empty, #overflow:empty { display: none; }
        #overflow { margin: 12px 0 0; border-top: 1px solid #000; padding-top: 6px; }
        [hidden] { display: none !important; }
        button { font: inherit; color: #000; background: #fff; border: 1px solid #000;
          border-radius: 0; cursor: pointer; }
        button:focus-visible { outline: 3px solid #000; outline-offset: 2px; }
        #navigation { display: flex; gap: 8px; margin: 10px 0; }
        #content.month { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
          gap: 20px; }
        #month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
          align-content: start; gap: 3px; }
        .weekday { text-align: center; font-size: 14px; padding: 4px 0; }
        .day { min-width: 0; min-height: 72px; padding: 3px; text-align: left;
          display: flex; flex-direction: column; align-items: stretch; }
        .day-event { display: block; font-size: 12px; line-height: 1.2;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .day[aria-pressed="true"] { background: #000; color: #fff; }
        .day[aria-current="date"] { border: 3px solid #000; font-weight: bold; }
        .count { display: block; font-size: 12px; }
        #content.month h2 { margin-top: 0; }
        :host([display-mode="trmnl"]) ha-card { width: 800px; height: 480px;
          overflow: hidden; }
        :host([display-mode="trmnl"]) #month { height: 320px;
          grid-template-rows: 26px repeat(var(--weeks), minmax(0, 1fr)); }
        :host([display-mode="trmnl"]) .day { min-height: 0; overflow: hidden;
          font-size: 14px; line-height: 1.1; }
        :host([display-mode="trmnl"]) .day-event,
        :host([display-mode="trmnl"]) .count { font-size: 11px; line-height: 1.1; }
        @media (max-width: 450px) {
          ha-card { padding: 12px; }
          :host([display-mode="responsive"]) #content.month { grid-template-columns: minmax(0, 1fr); }
        }
      </style>
      <ha-card>
        <header><h1></h1><span id="range"></span></header>
        <p id="status" role="status" aria-live="polite"></p>
        <nav id="navigation" aria-label="Month navigation">
          <button id="previous" aria-label="Previous month">‹</button>
          <button id="today">Today</button>
          <button id="next" aria-label="Next month">›</button>
        </nav>
        <div id="content">
          <div id="month" aria-label="Month days"></div>
          <main aria-label="Calendar events" aria-live="polite"></main>
        </div>
        <p id="overflow"></p>
      </ha-card>`;
    this.shadowRoot.querySelector("#previous").addEventListener("click", () => this._changeMonth(-1));
    this.shadowRoot.querySelector("#next").addEventListener("click", () => this._changeMonth(1));
    this.shadowRoot.querySelector("#today").addEventListener("click", () => this._changeMonth(0));
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities) || !config.entities.length
        || config.entities.some((entity) => typeof entity !== "string"
          || !/^calendar\.[a-z0-9_]+$/.test(entity))) {
      throw new Error("IDL Calendar requires a non-empty entities list of calendar.* entities.");
    }
    const days = config.days ?? 7;
    const maxEvents = config.max_events ?? 8;
    const refresh = config.refresh_interval ?? 300;
    const display = config.display_mode ?? "responsive";
    const view = config.view ?? "month";
    const weekStart = config.week_start ?? 1;
    if (!Number.isInteger(days) || days < 1 || days > 14
        || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 50
        || !Number.isInteger(refresh) || refresh < 60 || refresh > 86400) {
      throw new Error("days must be 1–14, max_events 1–50, and refresh_interval 60–86400 seconds.");
    }
    if (!["responsive", "trmnl"].includes(display)) {
      throw new Error("display_mode must be responsive or trmnl.");
    }
    if (!["month", "agenda"].includes(view) || ![0, 1].includes(weekStart)) {
      throw new Error("view must be month or agenda; week_start must be 0 (Sunday) or 1 (Monday).");
    }
    this._config = { ...config, entities: [...new Set(config.entities)],
      days, max_events: maxEvents, refresh_interval: refresh, display_mode: display,
      view, week_start: weekStart };
    this._month = null;
    this._selectedDay = null;
    this._request++;
    this._events = [];
    this._error = "";
    this._loading = true;
    this._lastFetch = 0;
    this.setAttribute("display-mode", display);
    this._render();
    this._startTimer();
    if (this._hass && this.isConnected) void this._refresh();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config && this.isConnected && !this._lastFetch) void this._refresh();
  }

  connectedCallback() {
    this._startTimer();
    if (this._hass && this._config) void this._refresh();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._request++;
    this._lastFetch = 0;
  }

  getCardSize() {
    return this._config?.display_mode === "trmnl" || this._config?.view === "month" ? 9 : 5;
  }

  static getStubConfig(hass) {
    return { entities: Object.keys(hass.states).filter((id) => id.startsWith("calendar.")).slice(0, 1) };
  }

  _startTimer() {
    clearInterval(this._timer);
    if (this.isConnected && this._config) {
      this._timer = setInterval(() => void this._refresh(), this._config.refresh_interval * 1000);
    }
  }

  _range() {
    return this._config.view === "month" ? monthRange(this._month ?? new Date())
      : calendarRange(this._config.days);
  }

  _changeMonth(offset) {
    const { start } = this._range();
    this._month = offset === 0 ? null
      : new Date(start.getFullYear(), start.getMonth() + offset, 1);
    this._selectedDay = this._month;
    this._events = [];
    this._error = "";
    this._loading = true;
    this._render();
    void this._refresh();
  }

  async _refresh() {
    if (!this._hass || !this._config || !this.isConnected) return;
    const request = ++this._request;
    const { start, end } = this._range();
    const hass = this._hass;
    const entities = this._config.entities;
    this._lastFetch = Date.now();
    const query = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
    const results = await Promise.allSettled(entities.map(async (entity) => {
      const state = hass.states[entity];
      if (!state || ["unavailable", "unknown"].includes(state.state)) {
        throw new Error("Calendar unavailable");
      }
      const events = await hass.callApi("GET", `calendars/${encodeURIComponent(entity)}?${query}`);
      if (!Array.isArray(events)) throw new Error("Invalid calendar response");
      const name = state.attributes?.friendly_name ?? entity;
      return events.map((event) => normalizeEvent(event, name))
        .filter((event) => event && event.start < end && event.end > start);
    }));
    if (request !== this._request || !this.isConnected) return;
    this._events = sortEvents(results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : []));
    const failures = results.filter((result) => result.status === "rejected").length;
    this._error = failures ? `${failures} calendar${failures === 1 ? "" : "s"} unavailable. Retrying automatically.` : "";
    this._loading = false;
    this._render();
  }

  _render() {
    if (!this._config) return;
    const root = this.shadowRoot;
    let { start, end } = this._range();
    const monthView = this._config.view === "month";
    const lastDay = new Date(end);
    lastDay.setDate(lastDay.getDate() - 1);
    root.querySelector("h1").textContent = this._config.title ?? "Calendar";
    root.querySelector("#range").textContent = monthView
      ? start.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : `${start.toLocaleDateString(undefined, DAY_FORMAT)} – ${lastDay.toLocaleDateString(undefined, DAY_FORMAT)}`;
    root.querySelector("#status").textContent = this._loading ? "Loading calendar…"
      : this._error || (!monthView && !this._events.length ? "No upcoming events." : "");
    root.querySelector("#navigation").hidden = !monthView;
    root.querySelector("#month").hidden = !monthView;
    root.querySelector("#content").className = monthView ? "month" : "";
    const main = root.querySelector("main");
    main.replaceChildren();
    let group;
    let key;
    let events = this._events;
    if (monthView) {
      const today = new Date();
      const selected = this._selectedDay >= start && this._selectedDay < end
        ? this._selectedDay : (today >= start && today < end ? today : start);
      this._renderMonth(start, end, selected, today);
      start = calendarRange(1, selected).start;
      events = eventsForDay(this._events, selected);
      const heading = document.createElement("h2");
      heading.textContent = selected.toLocaleDateString(undefined, DAY_FORMAT);
      group = document.createElement("ul");
      main.append(heading, group);
      if (!this._loading && !events.length) {
        const empty = document.createElement("p");
        empty.textContent = this._error ? "Day events unavailable or incomplete." : "No events this day.";
        main.append(empty);
      }
    }
    for (const event of events.slice(0, this._config.max_events)) {
      const day = event.start < start ? start : event.start;
      const nextKey = dateKey(day);
      if (!monthView && nextKey !== key) {
        const section = document.createElement("section");
        const heading = document.createElement("h2");
        heading.textContent = day.toLocaleDateString(undefined, DAY_FORMAT);
        group = document.createElement("ul");
        section.append(heading, group);
        main.append(section);
        key = nextKey;
      }
      const item = document.createElement("li");
      const summary = document.createElement("span");
      summary.className = "summary";
      summary.textContent = event.summary;
      item.append(summary);
      group.append(item);
    }
    const remaining = Math.max(0, events.length - this._config.max_events);
    root.querySelector("#overflow").textContent = remaining ? `+${remaining} more events` : "";
  }

  _renderMonth(start, end, selected, today) {
    const grid = this.shadowRoot.querySelector("#month");
    const focusedDate = this.shadowRoot.activeElement?.getAttribute("data-date");
    grid.replaceChildren();
    for (let index = 0; index < 7; index++) {
      const label = document.createElement("span");
      label.className = "weekday";
      label.textContent = new Date(2026, 0, 4 + (index + this._config.week_start) % 7)
        .toLocaleDateString(undefined, { weekday: "short" });
      grid.append(label);
    }
    const leading = (start.getDay() - this._config.week_start + 7) % 7;
    const days = new Date(end.getFullYear(), end.getMonth(), 0).getDate();
    const cells = Math.ceil((leading + days) / 7) * 7;
    grid.setAttribute("style", `--weeks: ${cells / 7}`);
    for (let index = 0; index < cells; index++) {
      const dayNumber = index - leading + 1;
      if (dayNumber < 1 || dayNumber > days) {
        grid.append(document.createElement("span"));
        continue;
      }
      const day = new Date(start.getFullYear(), start.getMonth(), dayNumber);
      const dayEvents = eventsForDay(this._events, day);
      const previewLimit = Math.min(this._config.max_events,
        this._config.display_mode === "trmnl" ? 1 : 3);
      const button = document.createElement("button");
      button.className = "day";
      button.textContent = String(dayNumber);
      button.setAttribute("data-date", dateKey(day));
      button.setAttribute("aria-pressed", String(dateKey(day) === dateKey(selected)));
      button.setAttribute("aria-label", `${day.toLocaleDateString(undefined, DAY_FORMAT)}: ${dayEvents.length} events${dayEvents.length ? `, ${dayEvents.map(event => event.summary).join(", ")}` : ""}`);
      if (dateKey(day) === dateKey(today)) button.setAttribute("aria-current", "date");
      for (const event of dayEvents.slice(0, previewLimit)) {
        const name = document.createElement("span");
        name.className = "day-event";
        name.textContent = event.summary;
        name.setAttribute("title", event.summary);
        button.append(name);
      }
      const remaining = dayEvents.length - previewLimit;
      if (remaining > 0) {
        const marker = document.createElement("span");
        marker.className = "count";
        marker.textContent = `+${remaining} more`;
        button.append(marker);
      }
      button.addEventListener("click", () => {
        this._selectedDay = day;
        this._render();
      });
      grid.append(button);
    }
    if (focusedDate) {
      this.shadowRoot.querySelector(`[data-date="${focusedDate}"]`)?.focus();
    }
  }
}

if (!customElements.get("idl-calendar")) customElements.define("idl-calendar", IdlCalendar);
window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "idl-calendar")) {
  window.customCards.push({
    type: "idl-calendar",
    name: "IDL Calendar",
    description: "Read-only monochrome calendar for low-resolution displays.",
  });
}
