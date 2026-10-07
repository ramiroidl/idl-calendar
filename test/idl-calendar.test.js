import assert from "node:assert/strict";
import { test } from "node:test";

class Element {
  constructor() {
    this.children = [];
    this.textContent = "";
    this.attributes = {};
    this.listeners = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  click() { this.listeners.click?.(); }
  focus() { this.focused = true; }
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
globalThis.document = { createElement: () => new Element() };
globalThis.window = {};
globalThis.customElements = { get() {}, define() {} };

const { IdlCalendar, calendarRange, monthRange, eventsForDay, dateKey, normalizeEvent, sortEvents } =
  await import("../idl-calendar.js");

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

test("configuration rejects invalid entities and bounds and deduplicates calendars", () => {
  const card = new IdlCalendar();
  for (const config of [{}, { entities: [] }, { entities: ["sensor.test"] },
    { entities: ["calendar.test"], days: 0 }, { entities: ["calendar.test"], max_events: 51 },
    { entities: ["calendar.test"], refresh_interval: 1 },
    { entities: ["calendar.test"], display_mode: "invalid" },
    { entities: ["calendar.test"], view: "invalid" },
    { entities: ["calendar.test"], week_start: 2 }]) {
    assert.throws(() => card.setConfig(config));
  }
  card.setConfig({ entities: ["calendar.test", "calendar.test"] });
  assert.deepEqual(card._config.entities, ["calendar.test"]);
});

function makeCard(entities, callApi, config = { view: "agenda" }) {
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
  const main = card.shadowRoot.querySelector("main");
  assert.equal(main.children[0].children[1].children[0].children[1].textContent, summary);
});

test("partial failures retain available calendars and display an error", async () => {
  const card = makeCard(["calendar.work", "calendar.family"], async (_, path) => {
    if (path.includes("family")) throw new Error("Offline");
    return [todayEvent()];
  });
  await card._refresh();
  assert.equal(card._events.length, 1);
  assert.match(card.shadowRoot.querySelector("#status").textContent, /1 calendar unavailable/);
});

test("empty calendars and unavailable entities have distinct statuses", async () => {
  const card = makeCard(["calendar.work"], async () => []);
  await card._refresh();
  assert.equal(card.shadowRoot.querySelector("#status").textContent, "No upcoming events.");
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

test("disconnect invalidates pending requests and clears refresh timer", async () => {
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
});

test("limits displayed events and counts remaining events", async () => {
  const card = makeCard(["calendar.work"], async () =>
    Array.from({ length: 10 }, (_, index) => todayEvent(`Event ${index}`)));
  await card._refresh();
  assert.equal(card.shadowRoot.querySelector("main").children[0].children[1].children.length, 8);
  assert.equal(card.shadowRoot.querySelector("#overflow").textContent, "+2 more events");
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

test("month is the default view and requests the entire native calendar month", async () => {
  const calls = [];
  const card = makeCard(["calendar.work"], async (...args) => {
    calls.push(args);
    return [todayEvent()];
  }, {});
  await card._refresh();
  const { start, end } = monthRange();
  const query = new URLSearchParams(calls[0][1].split("?")[1]);
  assert.equal(calls[0][0], "GET");
  assert.equal(query.get("start"), start.toISOString());
  assert.equal(query.get("end"), end.toISOString());
  assert.equal(card._config.view, "month");
  assert.equal(card.shadowRoot.querySelector("#navigation").hidden, false);
  assert.equal(card.shadowRoot.querySelector("main").children[1].children.length, 1);
});

test("month grid includes every date, handles six weeks, and selects day events locally", async () => {
  const calls = [];
  const card = makeCard(["calendar.work"], async (...args) => {
    calls.push(args);
    return [{ start: "2026-08-31", end: "2026-09-01", summary: "<b>Month end</b>" }];
  }, { view: "month", max_events: 1 });
  card._month = new Date(2026, 7, 1);
  card._selectedDay = card._month;
  await card._refresh();
  const grid = card.shadowRoot.querySelector("#month");
  const buttons = grid.children.filter(child => child.className === "day");
  assert.equal(grid.children.length, 7 + 42);
  assert.equal(buttons.length, 31);
  assert.equal(buttons[30].children[0].textContent, "1 •");
  buttons[30].click();
  assert.equal(calls.length, 1);
  const main = card.shadowRoot.querySelector("main");
  assert.equal(main.children[1].children[0].children[1].textContent, "<b>Month end</b>");
  assert.equal(card.shadowRoot.querySelector("#month").children
    .filter(child => child.attributes["aria-pressed"] === "true")[0].textContent, "31");
});

test("Sunday-first grids, empty days, and per-day overflow are rendered correctly", async () => {
  const card = makeCard(["calendar.work"], async () => [
    { start: "2026-02-02", end: "2026-02-03", summary: "One" },
    { start: "2026-02-02", end: "2026-02-03", summary: "Two" },
  ], { view: "month", week_start: 0, max_events: 1 });
  card._month = new Date(2026, 1, 1);
  card._selectedDay = card._month;
  await card._refresh();
  let grid = card.shadowRoot.querySelector("#month");
  assert.equal(grid.children.length, 7 + 28);
  assert.equal(grid.children[7].textContent, "1");
  assert.equal(card.shadowRoot.querySelector("main").children[2].textContent, "No events this day.");
  grid.children[8].click();
  assert.equal(card.shadowRoot.querySelector("#overflow").textContent, "+1 more events");
  grid = card.shadowRoot.querySelector("#month");
  grid.children[7].click();
  assert.equal(card.shadowRoot.querySelector("#overflow").textContent, "");
});

test("navigation crosses year boundaries, resets the day, and Today returns to current month", async () => {
  const calls = [];
  const card = makeCard(["calendar.work"], async (...args) => {
    calls.push(args);
    return [];
  }, { view: "month" });
  card._month = new Date(2026, 11, 1);
  card._changeMonth(1);
  await card._refresh();
  assert.equal(dateKey(card._month), "2027-01-01");
  assert.equal(dateKey(card._selectedDay), "2027-01-01");
  card._changeMonth(-1);
  await card._refresh();
  assert.equal(dateKey(card._month), "2026-12-01");
  card.shadowRoot.querySelector("#today").click();
  await card._refresh();
  assert.equal(card._month, null);
  assert.equal(card._selectedDay, null);
  assert.ok(calls.every(call => call[0] === "GET"));
});

test("month navigation ignores stale responses from the previous month", async () => {
  let resolveOld;
  let count = 0;
  const card = makeCard(["calendar.work"], async () => {
    if (++count === 1) return new Promise(resolve => { resolveOld = resolve; });
    return [];
  }, { view: "month" });
  const pending = card._refresh();
  card._changeMonth(1);
  await card._refresh();
  resolveOld([todayEvent("Old month")]);
  await pending;
  assert.deepEqual(card._events, []);
});

test("day selection and refresh restore keyboard focus to the same date", async () => {
  const card = makeCard(["calendar.work"], async () => [], { view: "month" });
  await card._refresh();
  let button = card.shadowRoot.querySelector("#month").children
    .find(child => child.className === "day");
  const date = button.getAttribute("data-date");
  card.shadowRoot.activeElement = button;
  button.click();
  button = card.shadowRoot.querySelector(`[data-date="${date}"]`);
  assert.equal(button.focused, true);
  card.shadowRoot.activeElement = button;
  await card._refresh();
  assert.equal(card.shadowRoot.querySelector(`[data-date="${date}"]`).focused, true);
});
