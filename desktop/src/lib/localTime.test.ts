import assert from "node:assert/strict";
import { test } from "node:test";
import { apiIsoToLocalInputValue, toLocalInputValue } from "./localTime.ts";

// Deterministic local timezone: Bogotá is UTC-5 year-round (no DST), the
// operator zone from support ticket 0659d873 (8:00 am shown as 1:00 pm).
process.env.TZ = "America/Bogota";

test("ticket 0659d873: agent-scheduled 8:00 am shows as 8:00 am, not UTC 1:00 pm", () => {
  // The API stores/serves the instant in UTC: 08:00-05:00 === 13:00Z.
  const api = "2026-10-20T13:00:00.000Z";
  assert.equal(apiIsoToLocalInputValue(api), "2026-10-20T08:00");
  // Guard against regressing to the old `iso.slice(0, 16)` behavior.
  assert.notEqual(api.slice(0, 16), apiIsoToLocalInputValue(api));
});

test("accepts any RFC3339 offset and normalizes to local wall time", () => {
  assert.equal(apiIsoToLocalInputValue("2026-10-20T08:00:00-05:00"), "2026-10-20T08:00");
  // 08:00 in Costa Rica (UTC-6) = 14:00Z = 09:00 in Bogotá (UTC-5).
  assert.equal(apiIsoToLocalInputValue("2026-10-20T08:00:00-06:00"), "2026-10-20T09:00");
});

test("datetime-local value round-trips through the save path unchanged", () => {
  // What the operator picks in the input (local, no offset) ...
  const picked = "2026-10-25T09:30";
  // ... FollowUpForm.save() converts with new Date(picked).toISOString() ...
  const saved = new Date(picked).toISOString();
  // ... reloading it must show exactly what was picked.
  assert.equal(apiIsoToLocalInputValue(saved), picked);
});

test("snooze-style local Date formats directly", () => {
  assert.equal(toLocalInputValue(new Date(2026, 9, 20, 8, 0)), "2026-10-20T08:00");
});

test("unparseable timestamps yield an empty value", () => {
  assert.equal(apiIsoToLocalInputValue("not-a-date"), "");
});
