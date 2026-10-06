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
          box-sizing: border-box; padding: 20px; background: #fff; color: #000;
          border: 2px solid #000; border-radius: 0; box-shadow: none;
          font-family: Arial, sans-serif; font-size: 18px; line-height: 1.3;
        }
        header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 20px;
          justify-content: space-between; border-bottom: 3px solid #000; padding-bottom: 10px; }
        h1 { font-size: 26px; margin: 0; }
        h2 { font-size: 18px; margin: 16px 0 4px; border-bottom: 1px solid #000; }
        ul { list-style: none; margin: 0; padding: 0; }
        li { display: grid; grid-template-columns: 105px minmax(0, 1fr);
          gap: 12px; padding: 5px 0; break-inside: avoid; }
        .summary { font-weight: bold; overflow-wrap: anywhere; }
        .calendar { display: block; font-size: 14px; font-weight: normal; }
        #status { margin: 12px 0 0; }
        #status:empty, #overflow:empty { display: none; }
        #overflow { margin: 12px 0 0; border-top: 1px solid #000; padding-top: 6px; }
        :host([display-mode="trmnl"]) ha-card { width: 800px; height: 480px;
          overflow: hidden; }
        @media (max-width: 450px) {
          ha-card { padding: 12px; }
          li { grid-template-columns: 85px minmax(0, 1fr); gap: 8px; }
        }
      </style>
      <ha-card>
        <header><h1></h1><span id="range"></span></header>
        <p id="status" role="status" aria-live="polite"></p>
        <main aria-label="Calendar events"></main>
        <p id="overflow"></p>
      </ha-card>`;
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
    if (!Number.isInteger(days) || days < 1 || days > 14
        || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 50
        || !Number.isInteger(refresh) || refresh < 60 || refresh > 86400) {
      throw new Error("days must be 1–14, max_events 1–50, and refresh_interval 60–86400 seconds.");
    }
    if (!["responsive", "trmnl"].includes(display)) {
      throw new Error("display_mode must be responsive or trmnl.");
    }
    this._config = { ...config, entities: [...new Set(config.entities)],
      days, max_events: maxEvents, refresh_interval: refresh, display_mode: display };
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
    return this._config?.display_mode === "trmnl" ? 9 : 5;
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

  async _refresh() {
    if (!this._hass || !this._config || !this.isConnected) return;
    const request = ++this._request;
    const { start, end } = calendarRange(this._config.days);
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
    const { start, end } = calendarRange(this._config.days);
    const lastDay = new Date(end);
    lastDay.setDate(lastDay.getDate() - 1);
    root.querySelector("h1").textContent = this._config.title ?? "Calendar";
    root.querySelector("#range").textContent = `${start.toLocaleDateString(undefined, DAY_FORMAT)} – ${lastDay.toLocaleDateString(undefined, DAY_FORMAT)}`;
    root.querySelector("#status").textContent = this._loading ? "Loading calendar…"
      : this._error || (this._events.length ? "" : "No upcoming events.");
    const main = root.querySelector("main");
    main.replaceChildren();
    let group;
    let key;
    for (const event of this._events.slice(0, this._config.max_events)) {
      const day = event.start < start ? start : event.start;
      const nextKey = dateKey(day);
      if (nextKey !== key) {
        const section = document.createElement("section");
        const heading = document.createElement("h2");
        heading.textContent = day.toLocaleDateString(undefined, DAY_FORMAT);
        group = document.createElement("ul");
        section.append(heading, group);
        main.append(section);
        key = nextKey;
      }
      const item = document.createElement("li");
      const time = document.createElement("span");
      time.textContent = event.allDay ? "All day" : event.start < start ? "Ongoing"
        : event.start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const summary = document.createElement("span");
      summary.className = "summary";
      summary.textContent = event.summary;
      if (this._config.entities.length > 1) {
        const calendar = document.createElement("span");
        calendar.className = "calendar";
        calendar.textContent = event.calendar;
        summary.append(calendar);
      }
      item.append(time, summary);
      group.append(item);
    }
    const remaining = Math.max(0, this._events.length - this._config.max_events);
    root.querySelector("#overflow").textContent = remaining ? `+${remaining} more events` : "";
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
