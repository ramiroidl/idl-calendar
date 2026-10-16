import assert from "node:assert/strict";
import { test } from "node:test";

class Element {
  constructor(tagName = "") {
    this.tagName = tagName;
    this.children = [];
    this.textContent = "";
    this.attributes = {};
    this.clientHeight = 48;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
}

globalThis.HTMLElement = class {
  attachShadow() {
    const elements = new Map();
    this.shadowRoot = {
      querySelector(selector) {
        if (selector.startsWith("[data-date=")) {
          const date = selector.match(/"([^"]+)"/)[1];
          return elements.get("#month")?.children.find(child => child.attributes["data-date"] === date);
        }
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
    };
  }
  setAttribute() {}
};
globalThis.document = { createElement: (tag) => new Element(tag) };
globalThis.window = {};
globalThis.customElements = { get() {}, define() {} };
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(element) { this.element = element; }
  disconnect() { this.disconnected = true; }
};

const { IdlCalendar, calendarRange, monthRange, eventsForDay, dateKey,
  normalizeEvent, sortEvents, visibleEventCount, normalizeForecast,
  weatherCondition } = await import("../idl-calendar.js");

test("calendar range starts at local midnight and spans calendar days", () => {
  const { start, end } = calendarRange(7, new Date(2026, 9, 6, 15, 30));
  assert.equal(dateKey(start), "2026-10-06");
  assert.equal(dateKey(end), "2026-10-13");
  assert.equal(start.getHours(), 0);
  assert.equal(end.getHours(), 0);
});

test("all-day dates use local midnight and retain exclusive end dates", () => {
  const event = normalizeEvent({ start: { date: "2026-10-06" },
    end: { date: "2026-10-08" }, summary: "Holiday" }, "Family");
  assert.equal(event.allDay, true);
  assert.equal(dateKey(event.start), "2026-10-06");
  assert.equal(event.start.getHours(), 0);
  assert.equal(dateKey(event.end), "2026-10-08");
});

test("timed events support object and string dates, malformed events are ignored", () => {
  const start = "2026-10-06T10:00:00+02:00";
  const end = "2026-10-06T11:00:00+02:00";
  assert.equal(normalizeEvent({ start, end }, "Work").start.toISOString(), "2026-10-06T08:00:00.000Z");
  assert.equal(normalizeEvent({ start: { dateTime: start }, end: { dateTime: end } }, "Work").allDay, false);
  for (const event of [null, {}, { start: "bad", end }, { start, end: start },
    { start: "2026-02-30", end: "2026-03-04" }]) {
    assert.equal(normalizeEvent(event, "Work"), null);
  }
});

test("events sort chronologically with all-day events first at equal starts", () => {
  const start = new Date(2026, 9, 6);
  const events = [{ start, allDay: false, summary: "Meeting" },
    { start, allDay: true, summary: "Holiday" }];
  assert.equal(sortEvents(events)[0].summary, "Holiday");
});

test("configuration validates entities, bounds and configured month", () => {
  const card = new IdlCalendar();
  for (const config of [{}, { entities: [] }, { entities: ["sensor.test"] },
    ...[{ max_events: 0 }, { max_events: 51 }, { refresh_interval: 1 },
      { display_mode: "invalid" }, { week_start: 2 }, { height: 359 }, { height: 2161 },
      { month: "2026-13" }, { month: "2026-02-01" }, { month: 2026 },
      { cross_out_past_days: "no" }, { weather: "yes" }]
      .map(options => ({ entities: ["calendar.test"], ...options }))]) {
    assert.throws(() => card.setConfig(config));
  }
  card.setConfig({ entities: ["calendar.test", "calendar.test"], month: "2026-12", height: 600 });
  assert.deepEqual(card._config.entities, ["calendar.test"]);
  assert.equal(dateKey(card._range().end), "2027-01-01");
  assert.equal(card._config.height, 600);
  card.setConfig({ entities: ["calendar.test"], display_mode: "trmnl", height: 600 });
  assert.equal(card._config.height, 480);
  assert.equal(card._config.cross_out_past_days, true);
  assert.equal(card._config.weather, true);
  card.setConfig({ entities: ["calendar.test"], cross_out_past_days: false });
  assert.equal(card._config.cross_out_past_days, false);
});

function forecastData(start = new Date(), unit = "°C") {
  return {
    daily: {
      time: Array.from({ length: 7 }, (_, index) => dateKey(calendarRange(index, start).end)),
      weather_code: [0, 2, 61, 71, 45, 95, 3],
      temperature_2m_max: [24.4, 23, 18, 0, 19, 21, 22],
      temperature_2m_min: [12.6, 12, 10, -5, 11, 14, 13],
    },
    daily_units: { temperature_2m_max: unit, temperature_2m_min: unit },
  };
}

test("forecast normalization retains local dates, rounds temperatures and maps WMO codes", () => {
  const forecast = normalizeForecast(forecastData(new Date(2026, 11, 29)));
  assert.equal(forecast.size, 7);
  assert.deepEqual(forecast.get("2026-12-29"),
    { icon: "sunny", label: "Sunny", max: 24, min: 13, unit: "°C" });
  assert.equal(forecast.get("2027-01-01").min, -5);
  assert.deepEqual([...forecast.values()].map(day => day.icon),
    ["sunny", "cloudy", "rainy", "snowy", "foggy", "stormy", "cloudy"]);
  for (const code of [51, 53, 55, 56, 57, 63, 65, 66, 67, 80, 81, 82]) {
    assert.equal(weatherCondition(code).icon, "rainy");
  }
  for (const code of [73, 75, 77, 85, 86]) assert.equal(weatherCondition(code).icon, "snowy");
  for (const code of [96, 99]) assert.equal(weatherCondition(code).icon, "stormy");
  assert.equal(weatherCondition(48).icon, "foggy");
  assert.equal(weatherCondition(999).icon, "unknown");
  assert.equal(weatherCondition("<svg>").icon, "unknown");
  assert.equal(normalizeForecast(forecastData(new Date(), "°F")).values().next().value.unit, "°F");
});

test("invalid or incomplete forecasts cannot appear as zero-degree weather", () => {
  for (const change of [
    data => { data.daily.temperature_2m_min[0] = null; },
    data => { data.daily.temperature_2m_max[0] = "24"; },
    data => { data.daily.temperature_2m_max[0] = Infinity; },
    data => { data.daily.temperature_2m_min[0] = 50; },
    data => { data.daily.time[0] = "2026-02-30"; },
    data => { data.daily.time[0] = data.daily.time[1]; },
    data => { data.daily.weather_code.pop(); },
    data => { data.daily_units.temperature_2m_max = "<img>"; },
    data => { data.daily_units.temperature_2m_min = "°F"; },
  ]) {
    const data = forecastData();
    change(data);
    assert.throws(() => normalizeForecast(data));
  }
  assert.throws(() => normalizeForecast({}));
  assert.throws(() => normalizeForecast(null));
});

function weatherCard(config = {}) {
  const card = makeCard(["calendar.work"], async () => [todayEvent()], config);
  card._hass.config = { latitude: 0, longitude: -58.4, time_zone: "America/Argentina/Buenos_Aires",
    unit_system: { temperature: "°C" } };
  return card;
}

test("weather uses HA coordinates and units without credentials, with independent hourly refresh", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => forecastData() };
  });
  const card = weatherCard({ refresh_interval: 86400 });
  await card._refreshWeather();
  const url = new URL(calls[0][0]);
  assert.equal(url.origin, "https://api.open-meteo.com");
  for (const [key, value] of Object.entries({ latitude: "0", longitude: "-58.4",
    timezone: "America/Argentina/Buenos_Aires", temperature_unit: "celsius", forecast_days: "7",
    daily: "weather_code,temperature_2m_max,temperature_2m_min" })) {
    assert.equal(url.searchParams.get(key), value);
  }
  assert.equal(calls[0][1].credentials, "omit");
  assert.equal(calls[0][1].referrerPolicy, "no-referrer");
  assert.equal(calls[0][1].headers, undefined);
  await card._refreshWeather();
  await card._refresh();
  assert.equal(calls.length, 1);
  card._startTimer();
  assert.equal(card._weatherTimer._idleTimeout, 3600000);
  assert.equal(card._timer._idleTimeout, 86400000);
  card._weatherTimer._onTimeout();
  await card._refreshWeather();
  assert.equal(calls.length, 2);
  card._weatherFetched -= 3600000;
  await card._refreshWeather();
  assert.equal(calls.length, 3);
  card._hass.config.unit_system.temperature = "°F";
  await card._refreshWeather();
  assert.equal(new URL(calls[3][0]).searchParams.get("temperature_unit"), "fahrenheit");
  card._hass.config.longitude = 20;
  await card._refreshWeather();
  assert.equal(new URL(calls[4][0]).searchParams.get("longitude"), "20");
  card.disconnectedCallback();
  assert.equal(card._weatherTimer._destroyed, true);
});

test("weather renders only today and the next six days without replacing events or today styling", () => {
  const card = weatherCard({ month: "2026-08" });
  card._forecast = normalizeForecast(forecastData(new Date(2026, 7, 15)));
  card._events = [normalizeEvent({ start: "2026-08-15", end: "2026-08-16",
    summary: "Lunch" }, "Family")];
  card._renderMonth(new Date(2026, 7, 1), new Date(2026, 8, 1), new Date(2026, 7, 15));
  const grid = card.shadowRoot.querySelector("#month");
  const forecasts = grid.children.flatMap(cell => cell.children.filter(child => child.className === "weather"));
  assert.equal(forecasts.length, 7);
  assert.match(forecasts[0].getAttribute("aria-label"), /Sunny, high 24°C, low 13°C/);
  assert.equal(forecasts[0].children[1].textContent, "24°/13°");
  assert.match(forecasts[0].children[0].innerHTML, /<svg/);
  const today = card.shadowRoot.querySelector('[data-date="2026-08-15"]');
  assert.equal(today.getAttribute("aria-current"), "date");
  assert.equal(today.children[1].children[0].textContent, "Lunch");
  card._renderMonth(new Date(2026, 7, 1), new Date(2026, 8, 1), new Date(2026, 7, 16));
  assert.equal(card.shadowRoot.querySelector('[data-date="2026-08-15"]').children.length, 2);
  card._renderMonth(new Date(2026, 8, 1), new Date(2026, 9, 1), new Date(2026, 7, 15));
  assert.ok(grid.children.every(cell => cell.children.length <= 2));
});

test("weather failures and missing coordinates do not hide calendar events and retry hourly", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return { ok: calls !== 2, json: async () => forecastData() };
  });
  const card = weatherCard();
  await card._refresh();
  await card._refreshWeather();
  assert.equal(card._forecast.size, 7);
  await card._refreshWeather(true);
  assert.equal(card._forecast.size, 0);
  assert.equal(card._events.length, 1);
  assert.match(card.shadowRoot.querySelector("#status").textContent, /Weather unavailable/);
  await card._refreshWeather();
  assert.equal(calls, 2);
  await card._refreshWeather(true);
  assert.equal(card._forecast.size, 7);
  assert.equal(card._weatherError, "");
  for (const latitude of [undefined, null, "0", 91]) {
    card._hass.config.latitude = latitude;
    await card._refreshWeather();
    assert.equal(card._forecast.size, 0);
  }
  assert.equal(calls, 3);
});

test("disabled weather never fetches and configuration/disconnect invalidate pending forecasts", async t => {
  const pending = [];
  t.mock.method(globalThis, "fetch", (_, options) => new Promise(resolve => {
    pending.push({ resolve, signal: options.signal });
  }));
  const card = weatherCard();
  const old = card._refreshWeather();
  card._hass.config.longitude = 30;
  const latest = card._refreshWeather();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => forecastData(new Date(), "°F") });
  await latest;
  pending[0].resolve({ ok: true, json: async () => forecastData() });
  await old;
  assert.equal(card._forecast.values().next().value.unit, "°F");
  const disconnected = card._refreshWeather(true);
  card.isConnected = false;
  card.disconnectedCallback();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve({ ok: true, json: async () => forecastData() });
  await disconnected;
  assert.equal(card._forecast.size, 0);
  card.setConfig({ entities: ["calendar.work"], weather: false });
  card.isConnected = true;
  await card._refreshWeather();
  assert.equal(pending.length, 3);
  card.disconnectedCallback();
});

test("changing configuration aborts weather requests and prevents stale forecasts", async t => {
  let resolve;
  let signal;
  t.mock.method(globalThis, "fetch", (_, options) => {
    signal = options.signal;
    return new Promise(done => { resolve = done; });
  });
  const card = weatherCard();
  const pending = card._refreshWeather();
  card.setConfig({ entities: ["calendar.work"], weather: false });
  assert.equal(signal.aborted, true);
  resolve({ ok: true, json: async () => forecastData() });
  await pending;
  assert.equal(card._forecast.size, 0);
  card.disconnectedCallback();
});

test("weather requests time out without interfering with calendar availability", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  t.mock.method(globalThis, "fetch", (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  });
  const card = weatherCard();
  await card._refresh();
  const pending = card._refreshWeather();
  t.mock.timers.tick(15000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(card._events.length, 1);
  assert.equal(card._forecast.size, 0);
  assert.match(card._weatherError, /Weather unavailable/);
});

function makeCard(entities, callApi, config = {}) {
  const card = new IdlCalendar();
  card.setConfig({ entities, ...config });
  card.isConnected = true;
  card._hass = { states: Object.fromEntries(entities.map((entity) =>
    [entity, { state: "off", attributes: { friendly_name: entity } }])), callApi };
  return card;
}

function todayEvent(summary = "Meeting") {
  const { start, end } = calendarRange(1);
  return { start: start.toISOString(), end: end.toISOString(), summary };
}

test("fetches only through authenticated GET API and renders untrusted text literally", async () => {
  const calls = [];
  const summary = '<img src=x onerror="alert(1)">';
  const card = makeCard(["calendar.work"], async (...args) => {
    calls.push(args);
    return [todayEvent(summary)];
  });
  await card._refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "GET");
  assert.match(calls[0][1], /^calendars\/calendar.work\?start=.*&end=/);
  assert.equal(card._events.length, 1);
  const cell = card.shadowRoot.querySelector(`[data-date="${dateKey(new Date())}"]`);
  assert.equal(cell.children[1].children[0].textContent, summary);
  assert.equal(cell.tagName, "section");
});

test("partial failures retain available calendars and expose accessible status", async () => {
  const card = makeCard(["calendar.work", "calendar.family"], async (_, path) => {
    if (path.includes("family")) throw new Error("Offline");
    return [todayEvent()];
  });
  await card._refresh();
  assert.equal(card._events.length, 1);
  assert.match(card.shadowRoot.querySelector("#status").textContent, /1 calendar unavailable/);
});

test("empty calendars and unavailable entities have distinct accessible statuses", async () => {
  const card = makeCard(["calendar.work"], async () => []);
  await card._refresh();
  assert.equal(card.shadowRoot.querySelector("#status").textContent, "No events this month.");
  card._hass.states["calendar.work"].state = "unavailable";
  await card._refresh();
  assert.match(card.shadowRoot.querySelector("#status").textContent, /unavailable/);
});

test("old requests cannot overwrite newer results", async () => {
  let resolveOld;
  let count = 0;
  const card = makeCard(["calendar.work"], async () => {
    if (++count === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return [todayEvent("New")];
  });
  const old = card._refresh();
  await card._refresh();
  resolveOld([todayEvent("Old")]);
  await old;
  assert.equal(card._events[0].summary, "New");
});

test("disconnect invalidates pending requests and clears timer and observer", async () => {
  let resolve;
  const card = makeCard(["calendar.work"], () => new Promise((done) => { resolve = done; }));
  card._startTimer();
  const pending = card._refresh();
  card.isConnected = false;
  card.disconnectedCallback();
  resolve([todayEvent()]);
  await pending;
  assert.equal(card._events.length, 0);
  assert.equal(card._timer._destroyed, true);
  assert.equal(card._resizeObserver.disconnected, true);
});

test("month ranges cover leap years and December rollover at local midnight", () => {
  for (const [date, first, next] of [
    [new Date(2024, 1, 29), "2024-02-01", "2024-03-01"],
    [new Date(2026, 11, 31), "2026-12-01", "2027-01-01"],
  ]) {
    const { start, end } = monthRange(date);
    assert.equal(dateKey(start), first);
    assert.equal(dateKey(end), next);
    assert.equal(start.getHours(), 0);
    assert.equal(end.getHours(), 0);
  }
});

test("day events include ongoing and multi-day events but exclude exclusive ends", () => {
  const events = [
    normalizeEvent({ start: "2026-10-05", end: "2026-10-07", summary: "Holiday" }, "Family"),
    normalizeEvent({ start: "2026-10-05T23:00:00", end: "2026-10-06T01:00:00", summary: "Night" }, "Work"),
    normalizeEvent({ start: "2026-10-05", end: "2026-10-06", summary: "Ended" }, "Family"),
    normalizeEvent({ start: "2026-10-07", end: "2026-10-08", summary: "Tomorrow" }, "Family"),
  ];
  assert.deepEqual(eventsForDay(events, new Date(2026, 9, 6)).map(event => event.summary),
    ["Holiday", "Night"]);
});

test("default period follows the current month and queries the whole month", async () => {
  const calls = [];
  const card = makeCard(["calendar.work"], async (...args) => {
    calls.push(args);
    return [];
  });
  await card._refresh();
  const { start, end } = monthRange();
  const query = new URLSearchParams(calls[0][1].split("?")[1]);
  assert.equal(query.get("start"), start.toISOString());
  assert.equal(query.get("end"), end.toISOString());
  assert.equal(card._month, null);
});

test("static grid includes weekday headings and every date in a six-week month", async () => {
  const card = makeCard(["calendar.work"], async () => [
    { start: "2026-08-31", end: "2026-09-01", summary: "<b>Month end</b>" },
  ], { month: "2026-08" });
  await card._refresh();
  const grid = card.shadowRoot.querySelector("#month");
  assert.equal(grid.children.length, 1 + 7 + 42);
  assert.equal(grid.children[0].className, "month-name");
  assert.equal(grid.children[0].textContent,
    new Date(2026, 7, 1).toLocaleDateString(undefined, { month: "short" }));
  assert.equal(grid.children.filter(child => child.className.split(" ").includes("day")).length, 31);
  assert.ok(grid.children.slice(1, 8).every(child => child.className === "weekday"));
  const rows = grid.children.slice(8);
  assert.ok(rows.every((child, index) =>
    child.className.split(" ").includes("row-start") === (index % 7 === 0)));
  const last = card.shadowRoot.querySelector('[data-date="2026-08-31"]');
  assert.equal(last.children[0].textContent, "31");
  assert.equal(last.children[1].children[0].textContent, "<b>Month end</b>");
  assert.equal(grid.getAttribute("style"), "--weeks: 6");
  assert.ok(grid.children.every(child => child.tagName !== "button"));
  assert.ok(!card.shadowRoot.innerHTML.includes("<nav"));
  assert.ok(!card.shadowRoot.innerHTML.includes("<main"));
  assert.ok(!card.shadowRoot.innerHTML.includes("<header"));
  assert.equal(card._changeMonth, undefined);
});

test("Sunday-first four-week grid and empty dates preserve numbers", async () => {
  const card = makeCard(["calendar.work"], async () => [], { month: "2026-02", week_start: 0 });
  await card._refresh();
  const grid = card.shadowRoot.querySelector("#month");
  assert.equal(grid.children.length, 1 + 7 + 28);
  assert.equal(grid.children[1].textContent,
    new Date(2026, 0, 4).toLocaleDateString(undefined, { weekday: "short" }));
  assert.ok(grid.children[8].className.split(" ").includes("row-start"));
  assert.equal(grid.children[8].children[0].textContent, "1");
  assert.equal(grid.children[8].children[1].children.length, 0);
});

test("past days are crossed out by default and can be disabled", async () => {
  const card = makeCard(["calendar.work"], async () => [], { month: "2026-08" });
  const start = new Date(2026, 7, 1);
  const end = new Date(2026, 8, 1);
  const today = new Date(2026, 7, 15);
  card._renderMonth(start, end, today);
  const classFor = date => card.shadowRoot.querySelector(`[data-date="${date}"]`).className;
  assert.equal(card.shadowRoot.querySelector('[data-date="2026-08-15"]').getAttribute("aria-current"), "date");
  assert.match(card.shadowRoot.innerHTML,
    /\.day\[aria-current="date"\] \.day-number\s*\{[^}]*background: #000; color: #fff;/);
  assert.ok(classFor("2026-08-14").split(" ").includes("past"));
  assert.ok(!classFor("2026-08-15").split(" ").includes("past"));
  assert.ok(!classFor("2026-08-16").split(" ").includes("past"));

  card.setConfig({ entities: ["calendar.work"], month: "2026-08", cross_out_past_days: false });
  card._renderMonth(start, end, today);
  assert.ok(!classFor("2026-08-14").split(" ").includes("past"));
  card.disconnectedCallback();
});

test("cell capacity reserves an overflow line only when needed", () => {
  assert.equal(visibleEventCount(3, 3, 8), 3);
  assert.equal(visibleEventCount(4, 3, 8), 2);
  assert.equal(visibleEventCount(10, 5, 2), 2);
  assert.equal(visibleEventCount(2, 1, 8), 0);
  assert.equal(visibleEventCount(0, 0, 8), 0);
});

test("event names appear on overlapping dates without time or calendar labels", async () => {
  const card = makeCard(["calendar.work", "calendar.family"], async (_, path) =>
    path.includes("family") ? [] : [
      { start: "2026-08-05", end: "2026-08-07", summary: "Holiday" },
      { start: "2026-08-05T09:00:00", end: "2026-08-05T10:00:00", summary: "Meeting" },
    ], { month: "2026-08" });
  await card._refresh();
  const names = date => card.shadowRoot.querySelector(`[data-date="${date}"]`)
    .children[1].children.map(child => child.textContent);
  assert.deepEqual(names("2026-08-05"), ["Holiday", "Meeting"]);
  assert.deepEqual(names("2026-08-06"), ["Holiday"]);
  assert.deepEqual(names("2026-08-07"), []);
});

test("resizing refits the names that fit and keeps +n accurate", async () => {
  const card = makeCard(["calendar.work"], async () =>
    Array.from({ length: 5 }, (_, index) => ({
      start: "2026-08-31", end: "2026-09-01", summary: `Event ${index}`,
    })), { month: "2026-08" });
  await card._refresh();
  const list = card.shadowRoot.querySelector('[data-date="2026-08-31"]').children[1];
  assert.deepEqual(list.children.map(child => child.textContent), ["Event 0", "Event 1", "+3"]);
  list.clientHeight = 80;
  card._resizeObserver.callback();
  assert.equal(list.children.length, 5);
  assert.ok(list.children.every(child => child.className === "day-event"));
  list.clientHeight = 16;
  card._resizeObserver.callback();
  assert.deepEqual(list.children.map(child => child.textContent), ["+5"]);
});

test("configuration changes invalidate old month requests", async () => {
  let resolveOld;
  let count = 0;
  const card = makeCard(["calendar.work"], async () => {
    if (++count === 1) return new Promise(resolve => { resolveOld = resolve; });
    return [];
  });
  const pending = card._refresh();
  card.setConfig({ entities: ["calendar.work"], month: "2027-01" });
  await card._refresh();
  resolveOld([todayEvent("Old month")]);
  await pending;
  assert.deepEqual(card._events, []);
  assert.equal(dateKey(card._range().start), "2027-01-01");
  card.disconnectedCallback();
});
