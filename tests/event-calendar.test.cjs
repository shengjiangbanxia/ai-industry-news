const { test } = require("node:test");
const assert = require("node:assert/strict");
const { groupEvents, beijingDate } = require("../assets/event-calendar.js");
const event = (id, start, end, extra = {}) => ({ id, start_date: start, end_date: end, status: "confirmed", ...extra });

test("recent window uses end date and includes 30 days, sorted most recently ended first", () => {
  const result = groupEvents([
    event("old", "2026-10-01", "2026-10-21"),
    event("boundary", "2026-10-01", "2026-10-22"),
    event("sc", "2026-11-15", "2026-11-20"),
    event("ongoing", "2026-11-20", "2026-11-22"),
    event("later", "2027-01-06", "2027-01-09"),
    event("beyond-horizon", "2027-06-01", "2027-06-04"),
    event("cancelled", "2026-11-15", "2026-11-20", { status: "cancelled" }),
    event("unknown", null, null, { status: "unannounced", priority: "core" }),
  ], "2026-11-21");
  assert.deepEqual(result.recent.map(x => x.id), ["sc", "boundary"]);
  assert.equal(result.recent[0].status, "completed");
  assert.equal(result.upcoming[0].ongoing, true);
  assert.deepEqual(result.upcoming.map(x => x.id), ["ongoing", "later", "beyond-horizon"]);
  assert.deepEqual(result.pending.map(x => x.id), ["unknown"]);
  assert.equal(result.pending[0].days_remaining, null);
});

test("Beijing midnight switches day, and recent events survive without any upcoming event", () => {
  assert.equal(beijingDate(new Date("2026-11-20T16:00:00Z")), "2026-11-21");
  const result = groupEvents([event("sc", "2026-11-15", "2026-11-20")], "2026-11-21");
  assert.equal(result.upcoming.length, 0);
  assert.equal(result.recent.length, 1);
});
