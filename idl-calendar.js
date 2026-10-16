const DAY_FORMAT = { weekday: "short", month: "short", day: "numeric" };
const WEATHER_INTERVAL = 3600000;
const WEATHER_ICONS = {
  sunny: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  cloudy: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11Z"/>',
  rainy: '<path d="M5 14a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 2 9M7 17l-2 4m8-4-2 4m8-4-2 4"/>',
  snowy: '<path d="M12 2v20M3 7l18 10M3 17 21 7M9 4l3 3 3-3M9 20l3-3 3 3M3 10l4-1-1-4m12 14-1-4 4-1M3 14l4 1-1 4M18 5l-1 4 4 1"/>',
  foggy: '<path d="M3 6h18M1 10h18M5 14h18M2 18h18"/>',
  stormy: '<path d="M5 14a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 2 9M12 12l-4 6h5l-3 5"/>',
  unknown: '<path d="M8 7a4 4 0 1 1 6 4c-2 1-2 2-2 4m0 3v2"/>',
};

export function weatherCondition(code) {
  if (code === 0) return { icon: "sunny", label: "Sunny" };
  if ([1, 2].includes(code)) return { icon: "cloudy", label: "Partly cloudy" };
  if (code === 3) return { icon: "cloudy", label: "Overcast" };
  if ([45, 48].includes(code)) return { icon: "foggy", label: "Fog" };
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return { icon: "rainy", label: "Rain" };
  }
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: "snowy", label: "Snow" };
  if ([95, 96, 99].includes(code)) return { icon: "stormy", label: "Thunderstorm" };
  return { icon: "unknown", label: "Unknown weather" };
}

export function normalizeForecast(data) {
  const daily = data?.daily;
  if (!daily || !["time", "weather_code", "temperature_2m_max", "temperature_2m_min"]
    .every(key => Array.isArray(daily[key]) && daily[key].length === 7)
      || !["°C", "°F"].includes(data.daily_units?.temperature_2m_max)
      || data.daily_units.temperature_2m_min !== data.daily_units.temperature_2m_max) {
    throw new Error("Invalid weather response");
  }
  if (new Set(daily.time).size !== 7) throw new Error("Duplicate forecast dates");
  return new Map(daily.time.map((date, index) => {
    const max = daily.temperature_2m_max[index];
    const min = daily.temperature_2m_min[index];
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || !eventDate(date) || !Number.isFinite(max) || !Number.isFinite(min) || min > max) {
      throw new Error("Invalid daily forecast");
    }
    return [date, { ...weatherCondition(daily.weather_code[index]), max: Math.round(max),
      min: Math.round(min), unit: data.daily_units.temperature_2m_max }];
  }));
}

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
    this._forecast = new Map();
    this._weatherRequest = 0;
    this._weatherError = "";
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
        #month { display: grid; grid-template-columns: auto repeat(7, minmax(0, 1fr));
          height: 100%; grid-template-rows: 26px repeat(var(--weeks), minmax(0, 1fr));
          gap: 3px; }
        .weekday { text-align: center; font-size: 14px; line-height: 26px; }
        .month-name { font-size: 14px; font-weight: bold; line-height: 26px; padding-right: 4px; }
        .row-start { grid-column-start: 2; }
        .day { position: relative; min-width: 0; min-height: 0; padding: 3px; border: 1px solid #000;
          display: flex; flex-direction: column; overflow: hidden; }
        .day.past::after { content: ""; position: absolute; inset: 0; pointer-events: none;
          opacity: 0.5;
          background: linear-gradient(135deg, transparent 47%, #000 49%, #000 51%, transparent 53%),
            linear-gradient(45deg, transparent 47%, #000 49%, #000 51%, transparent 53%); }
        .day-number { font-size: 16px; line-height: 20px; flex: none; }
        .weather { position: absolute; top: 3px; right: 3px; display: flex;
          align-items: center; gap: 2px; font-size: 10px; line-height: 20px; }
        .weather svg { width: 16px; height: 16px; }
        .day[aria-current="date"] .weather { color: #fff; }
        .events { list-style: none; margin: 0; padding: 0; flex: 1; min-height: 0;
          font-size: 12px; line-height: 16px; overflow: hidden; }
        .day-event, .count { display: block; height: 16px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .day[aria-current="date"] .day-number {
          margin: -3px -3px 0; padding: 3px; background: #000; color: #fff;
          font-weight: bold;
        }
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
    const crossOutPastDays = config.cross_out_past_days ?? true;
    const weather = config.weather ?? true;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 50
        || !Number.isInteger(refresh) || refresh < 60 || refresh > 86400) {
      throw new Error("max_events must be 1–50 and refresh_interval 60–86400 seconds.");
    }
    if (typeof crossOutPastDays !== "boolean") {
      throw new Error("cross_out_past_days must be a boolean.");
    }
    if (typeof weather !== "boolean") throw new Error("weather must be a boolean.");
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
      height: display === "trmnl" ? 480 : height, week_start: weekStart,
      cross_out_past_days: crossOutPastDays, weather };
    this._month = month;
    this._request++;
    this._events = [];
    this._error = "";
    this._loading = true;
    this._lastFetch = 0;
    this._resetWeather();
    this.setAttribute("display-mode", display);
    this.shadowRoot.querySelector("ha-card").setAttribute("style", `height: ${this._config.height}px`);
    this._render();
    this._startTimer();
    if (this._hass && this.isConnected) {
      void this._refresh();
      void this._refreshWeather();
    }
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config && this.isConnected && !this._lastFetch) void this._refresh();
    void this._refreshWeather();
  }

  connectedCallback() {
    this._resizeObserver?.observe(this.shadowRoot.querySelector("#month"));
    this._fitEvents();
    this._startTimer();
    if (this._hass && this._config) {
      void this._refresh();
      void this._refreshWeather();
    }
  }

  disconnectedCallback() {
    this._resizeObserver?.disconnect();
    clearInterval(this._timer);
    clearInterval(this._weatherTimer);
    this._resetWeather();
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
    clearInterval(this._weatherTimer);
    if (this.isConnected && this._config) {
      this._timer = setInterval(() => void this._refresh(), this._config.refresh_interval * 1000);
      if (this._config.weather) {
        this._weatherTimer = setInterval(() => void this._refreshWeather(true), WEATHER_INTERVAL);
      }
    }
  }

  _resetWeather() {
    this._weatherRequest++;
    this._weatherController?.abort();
    this._weatherKey = null;
    this._weatherFetched = null;
    this._forecast.clear();
    this._weatherError = "";
  }

  async _refreshWeather(force = false) {
    if (!this._hass || !this._config?.weather || !this.isConnected) return;
    const config = this._hass.config;
    const latitude = config?.latitude;
    const longitude = config?.longitude;
    const unit = config?.unit_system?.temperature === "°F" ? "fahrenheit" : "celsius";
    const timezone = config?.time_zone || "auto";
    const key = JSON.stringify([latitude, longitude, unit, timezone]);
    if (!force && key === this._weatherKey && this._weatherFetched !== null
        && Date.now() - this._weatherFetched < WEATHER_INTERVAL) return;
    const changed = key !== this._weatherKey;
    const request = ++this._weatherRequest;
    this._weatherController?.abort();
    const controller = new AbortController();
    this._weatherController = controller;
    this._weatherKey = key;
    this._weatherFetched = Date.now();
    if (changed) this._forecast.clear();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
          || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
        throw new Error("Home Assistant coordinates unavailable");
      }
      const query = new URLSearchParams({ latitude, longitude, timezone, temperature_unit: unit,
        daily: "weather_code,temperature_2m_max,temperature_2m_min", forecast_days: "7" });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`,
        { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("Weather unavailable");
      const forecast = normalizeForecast(await response.json());
      if (request !== this._weatherRequest || !this.isConnected) return;
      this._forecast = forecast;
      this._weatherError = "";
    } catch {
      if (request !== this._weatherRequest || !this.isConnected) return;
      this._forecast.clear();
      this._weatherError = "Weather unavailable. Retrying automatically.";
    } finally {
      clearTimeout(timeout);
    }
    this._render();
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
    root.querySelector("#status").textContent = [
      this._loading ? "Loading calendar…"
        : this._error || (this._events.length ? "" : "No events this month."),
      this._weatherError,
    ].filter(Boolean).join(" ");
    root.querySelector("#month").setAttribute("aria-label",
      start.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
    this._renderMonth(start, end, new Date());
  }

  _renderMonth(start, end, today) {
    const grid = this.shadowRoot.querySelector("#month");
    grid.replaceChildren();
    this._dayLists = [];
    const monthName = document.createElement("span");
    monthName.className = "month-name";
    monthName.textContent = start.toLocaleDateString(undefined, { month: "short" });
    grid.append(monthName);
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
      const rowStart = index % 7 === 0 ? " row-start" : "";
      if (dayNumber < 1 || dayNumber > days) {
        const blank = document.createElement("span");
        blank.className = rowStart.trim();
        grid.append(blank);
        continue;
      }
      const day = new Date(start.getFullYear(), start.getMonth(), dayNumber);
      const dayEvents = eventsForDay(this._events, day);
      const cell = document.createElement("section");
      const isPast = this._config.cross_out_past_days && dateKey(day) < dateKey(today);
      cell.className = `day${rowStart}${isPast ? " past" : ""}`;
      cell.setAttribute("data-date", dateKey(day));
      cell.setAttribute("aria-label", `${day.toLocaleDateString(undefined, DAY_FORMAT)}: ${dayEvents.length} events${dayEvents.length ? `, ${dayEvents.map(event => event.summary).join(", ")}` : ""}`);
      if (dateKey(day) === dateKey(today)) cell.setAttribute("aria-current", "date");
      const number = document.createElement("span");
      number.className = "day-number";
      number.textContent = String(dayNumber);
      const list = document.createElement("ul");
      list.className = "events";
      cell.append(number, list);
      const forecast = this._config.weather && dateKey(day) >= dateKey(today)
        && dateKey(day) < dateKey(calendarRange(7, today).end)
        ? this._forecast.get(dateKey(day)) : null;
      if (forecast) {
        const weather = document.createElement("span");
        weather.className = "weather";
        const label = `${forecast.label}, high ${forecast.max}${forecast.unit}, low ${forecast.min}${forecast.unit}`;
        weather.setAttribute("aria-label", label);
        weather.setAttribute("title", label);
        const icon = document.createElement("span");
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WEATHER_ICONS[forecast.icon]}</svg>`;
        const temperatures = document.createElement("span");
        temperatures.textContent = `${forecast.max}°/${forecast.min}°`;
        weather.append(icon, temperatures);
        cell.append(weather);
      }
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
