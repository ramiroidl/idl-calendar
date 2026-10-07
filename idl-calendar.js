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

export function visibleEventCount(total, slots, maxEvents) {
  const limit = Math.max(0, Math.min(slots, maxEvents));
  return total <= limit ? total : Math.max(0, Math.min(slots - 1, maxEvents));
}

export class IdlCalendar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._events = [];
    this._request = 0;
    this._loading = true;
    this._error = "";
    this._dayLists = [];
    this._resizeObserver = typeof ResizeObserver === "undefined" ? null
      : new ResizeObserver(() => this._fitEvents());
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; color: #000; background: #fff; }
        ha-card {
          display: block; box-sizing: border-box; padding: 8px; background: #fff; color: #000;
          border: 2px solid #000; border-radius: 0; box-shadow: none;
          font-family: Arial, sans-serif; font-size: 18px; line-height: 1.3;
        }
        #status { position: absolute; width: 1px; height: 1px; overflow: hidden;
          clip-path: inset(50%); }
        #month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr));
          height: 100%; grid-template-rows: 26px repeat(var(--weeks), minmax(0, 1fr));
          gap: 3px; }
        .weekday { text-align: center; font-size: 14px; line-height: 26px; }
        .day { min-width: 0; min-height: 0; padding: 3px; border: 1px solid #000;
          display: flex; flex-direction: column; overflow: hidden; }
        .day-number { font-size: 16px; line-height: 20px; flex: none; }
        .events { list-style: none; margin: 0; padding: 0; flex: 1; min-height: 0;
          font-size: 12px; line-height: 16px; overflow: hidden; }
        .day-event, .count { display: block; height: 16px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .day[aria-current="date"] .day-number { font-weight: bold; text-decoration: underline; }
        :host([display-mode="trmnl"]) ha-card { width: 800px; }
      </style>
      <ha-card>
        <p id="status" role="status" aria-live="polite"></p>
        <div id="month" role="group" aria-label="Month days"></div>
      </ha-card>`;
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities) || !config.entities.length
        || config.entities.some((entity) => typeof entity !== "string"
          || !/^calendar\.[a-z0-9_]+$/.test(entity))) {
      throw new Error("IDL Calendar requires a non-empty entities list of calendar.* entities.");
    }
    const maxEvents = config.max_events ?? 8;
    const refresh = config.refresh_interval ?? 300;
    const display = config.display_mode ?? "responsive";
    const height = config.height ?? 480;
    const month = config.month == null ? null : eventDate(`${config.month}-01`);
    const weekStart = config.week_start ?? 1;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 50
        || !Number.isInteger(refresh) || refresh < 60 || refresh > 86400) {
      throw new Error("max_events must be 1–50 and refresh_interval 60–86400 seconds.");
    }
    if (!["responsive", "trmnl"].includes(display)) {
      throw new Error("display_mode must be responsive or trmnl.");
    }
    if (![0, 1].includes(weekStart) || !Number.isInteger(height) || height < 360 || height > 2160
        || (config.month != null && (typeof config.month !== "string"
          || !/^\d{4}-\d{2}$/.test(config.month) || !month))) {
      throw new Error("week_start must be 0 or 1, height 360–2160, and month YYYY-MM.");
    }
    this._config = { ...config, entities: [...new Set(config.entities)],
      max_events: maxEvents, refresh_interval: refresh, display_mode: display,
      height: display === "trmnl" ? 480 : height, week_start: weekStart };
    this._month = month;
    this._request++;
    this._events = [];
    this._error = "";
    this._loading = true;
    this._lastFetch = 0;
    this.setAttribute("display-mode", display);
    this.shadowRoot.querySelector("ha-card").setAttribute("style", `height: ${this._config.height}px`);
    this._render();
    this._startTimer();
    if (this._hass && this.isConnected) void this._refresh();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config && this.isConnected && !this._lastFetch) void this._refresh();
  }

  connectedCallback() {
    this._resizeObserver?.observe(this.shadowRoot.querySelector("#month"));
    this._fitEvents();
    this._startTimer();
    if (this._hass && this._config) void this._refresh();
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    clearInterval(this._timer);
    this._request++;
    this._lastFetch = 0;
  }

  getCardSize() {
    return Math.ceil((this._config?.height ?? 480) / 50);
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
    return monthRange(this._month ?? new Date());
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
    const { start, end } = this._range();
    root.querySelector("#status").textContent = this._loading ? "Loading calendar…"
      : this._error || (this._events.length ? "" : "No events this month.");
    root.querySelector("#month").setAttribute("aria-label",
      start.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
    this._renderMonth(start, end, new Date());
  }

  _renderMonth(start, end, today) {
    const grid = this.shadowRoot.querySelector("#month");
    grid.replaceChildren();
    this._dayLists = [];
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
      const cell = document.createElement("section");
      cell.className = "day";
      cell.setAttribute("data-date", dateKey(day));
      cell.setAttribute("aria-label", `${day.toLocaleDateString(undefined, DAY_FORMAT)}: ${dayEvents.length} events${dayEvents.length ? `, ${dayEvents.map(event => event.summary).join(", ")}` : ""}`);
      if (dateKey(day) === dateKey(today)) cell.setAttribute("aria-current", "date");
      const number = document.createElement("span");
      number.className = "day-number";
      number.textContent = String(dayNumber);
      const list = document.createElement("ul");
      list.className = "events";
      cell.append(number, list);
      this._dayLists.push({ list, events: dayEvents });
      grid.append(cell);
    }
    this._fitEvents();
  }

  _fitEvents() {
    for (const { list, events } of this._dayLists) {
      const slots = Math.floor(list.clientHeight / 16);
      const visible = visibleEventCount(events.length, slots, this._config.max_events);
      list.replaceChildren();
      for (const event of events.slice(0, visible)) {
        const name = document.createElement("li");
        name.className = "day-event";
        name.textContent = event.summary;
        list.append(name);
      }
      const remaining = events.length - visible;
      if (remaining > 0) {
        const marker = document.createElement("li");
        marker.className = "count";
        marker.textContent = `+${remaining}`;
        list.append(marker);
      }
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
