import assert from "node:assert/strict";
import { test } from "node:test";

class Element {
  constructor() {
    this.children = [];
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

globalThis.HTMLElement = class {
  attachShadow() {
    const elements = new Map();
    this.shadowRoot = {
      querySelector(selector) {
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

const { IdlCalendar, calendarRange, dateKey, normalizeEvent, sortEvents } =
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
    { entities: ["calendar.test"], display_mode: "invalid" }]) {
    assert.throws(() => card.setConfig(config));
  }
  card.setConfig({ entities: ["calendar.test", "calendar.test"] });
  assert.deepEqual(card._config.entities, ["calendar.test"]);
});

function makeCard(entities, callApi) {
  const card = new IdlCalendar();
  card.setConfig({ entities });
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
