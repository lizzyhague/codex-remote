import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CITY_TIME_ZONE,
  DISPLAY_TIME_ZONES,
  DISPLAY_TIMEZONE_KEY,
  formatDisplayTime,
  loadDisplayTimezonePreference,
  normalizeDisplayTimezonePreference,
  parseDisplayTimezonePreference,
  resolveDisplayTimeZone,
  saveDisplayTimezonePreference,
} from "./display-timezone.js";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.hasOwn(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
  };
}

test("the city list uses IANA identifiers and defaults to Shanghai without following the device", () => {
  assert.equal(DISPLAY_TIMEZONE_KEY, "codex-remote.display-timezone");
  assert.deepEqual(
    DISPLAY_TIME_ZONES.map((city) => city.id),
    [
      "Asia/Shanghai",
      "Asia/Tokyo",
      "Europe/London",
      "Europe/Paris",
      "America/New_York",
      "America/Los_Angeles",
    ],
  );
  assert.equal(DEFAULT_CITY_TIME_ZONE, "Asia/Shanghai");
  assert.deepEqual(parseDisplayTimezonePreference(""), {
    followDevice: false,
    cityTimeZone: "Asia/Shanghai",
  });
});

test("unknown or corrupt saved values fall back without clearing a known city", () => {
  assert.deepEqual(parseDisplayTimezonePreference("{"), {
    followDevice: false,
    cityTimeZone: "Asia/Shanghai",
  });
  assert.deepEqual(
    normalizeDisplayTimezonePreference({
      followDevice: true,
      cityTimeZone: "Not/AZone",
    }),
    { followDevice: true, cityTimeZone: "Asia/Shanghai" },
  );
  assert.deepEqual(
    normalizeDisplayTimezonePreference({
      followDevice: "yes",
      cityTimeZone: "Europe/London",
    }),
    { followDevice: false, cityTimeZone: "Europe/London" },
  );
});

test("follow-device reads the supplied browser zone and keeps the last city", () => {
  const stored = {
    followDevice: true,
    cityTimeZone: "America/New_York",
  };
  assert.equal(resolveDisplayTimeZone(stored, "Europe/Paris"), "Europe/Paris");
  assert.equal(
    resolveDisplayTimeZone({ ...stored, followDevice: false }, "Europe/Paris"),
    "America/New_York",
  );
  assert.equal(resolveDisplayTimeZone(stored, ""), "Asia/Shanghai");
});

test("saving writes the IANA city id, not a numeric offset", () => {
  const storage = memoryStorage();
  const saved = saveDisplayTimezonePreference({
    followDevice: true,
    cityTimeZone: "Europe/London",
  }, storage);
  assert.deepEqual(saved, { followDevice: true, cityTimeZone: "Europe/London" });
  const raw = storage.getItem(DISPLAY_TIMEZONE_KEY);
  assert.equal(JSON.parse(raw).cityTimeZone, "Europe/London");
  assert.doesNotMatch(raw, /offset|UTC\+|getTimezoneOffset/u);
  assert.deepEqual(loadDisplayTimezonePreference(storage), saved);
});

test("city mode converts each timestamp with that city's DST rules", () => {
  const winter = Date.UTC(2026, 0, 15, 12, 0, 0);
  const summer = Date.UTC(2026, 6, 15, 12, 0, 0);
  assert.equal(formatDisplayTime(winter, "Asia/Shanghai"), "01-15 20:00");
  assert.equal(formatDisplayTime(summer, "Asia/Shanghai"), "07-15 20:00");
  assert.equal(formatDisplayTime(winter, "Asia/Tokyo"), "01-15 21:00");
  assert.equal(formatDisplayTime(summer, "Asia/Tokyo"), "07-15 21:00");
  assert.equal(formatDisplayTime(winter, "Europe/London"), "01-15 12:00");
  assert.equal(formatDisplayTime(summer, "Europe/London"), "07-15 13:00");
  assert.equal(formatDisplayTime(winter, "Europe/Paris"), "01-15 13:00");
  assert.equal(formatDisplayTime(summer, "Europe/Paris"), "07-15 14:00");
  assert.equal(formatDisplayTime(winter, "America/New_York"), "01-15 07:00");
  assert.equal(formatDisplayTime(summer, "America/New_York"), "07-15 08:00");
  assert.equal(formatDisplayTime(winter, "America/Los_Angeles"), "01-15 04:00");
  assert.equal(formatDisplayTime(summer, "America/Los_Angeles"), "07-15 05:00");
});

test("London spring-forward is applied to that date, not today's offset", () => {
  const before = Date.UTC(2026, 2, 29, 0, 30, 0);
  const after = Date.UTC(2026, 2, 29, 1, 30, 0);
  assert.equal(formatDisplayTime(before, "Europe/London"), "03-29 00:30");
  assert.equal(formatDisplayTime(after, "Europe/London"), "03-29 02:30");
});
