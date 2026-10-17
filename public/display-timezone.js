/** Per-site display-time-zone preference stored in the browser. It is not sent to the server or synced across devices or apps. */
export const DISPLAY_TIMEZONE_KEY = "codex-remote.display-timezone";
export const DEFAULT_CITY_TIME_ZONE = "Asia/Shanghai";

export const DISPLAY_TIME_ZONES = [
  { id: "Asia/Shanghai", label: "上海" },
  { id: "Asia/Tokyo", label: "东京" },
  { id: "Europe/London", label: "伦敦" },
  { id: "Europe/Paris", label: "巴黎" },
  { id: "America/New_York", label: "纽约" },
  { id: "America/Los_Angeles", label: "洛杉矶" },
];

const CITY_IDS = new Set(DISPLAY_TIME_ZONES.map((city) => city.id));

function defaultPreference() {
  return { followDevice: false, cityTimeZone: DEFAULT_CITY_TIME_ZONE };
}

export function isValidTimeZone(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeDisplayTimezonePreference(input) {
  const cityTimeZone = CITY_IDS.has(input?.cityTimeZone)
    ? input.cityTimeZone
    : DEFAULT_CITY_TIME_ZONE;
  return {
    followDevice: input?.followDevice === true,
    cityTimeZone,
  };
}

export function parseDisplayTimezonePreference(raw) {
  if (typeof raw !== "string" || raw.length === 0) return defaultPreference();
  try {
    return normalizeDisplayTimezonePreference(JSON.parse(raw));
  } catch {
    return defaultPreference();
  }
}

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadDisplayTimezonePreference(storage) {
  const store = storageOf(storage);
  if (!store) return defaultPreference();
  try {
    return parseDisplayTimezonePreference(store.getItem(DISPLAY_TIMEZONE_KEY));
  } catch {
    return defaultPreference();
  }
}

export function saveDisplayTimezonePreference(input, storage) {
  const next = normalizeDisplayTimezonePreference(input);
  const store = storageOf(storage);
  if (!store) return next;
  try {
    store.setItem(DISPLAY_TIMEZONE_KEY, JSON.stringify(next));
  } catch {
    // If the browser disables local storage, the current page can still use the in-memory choice.
  }
  return next;
}

/** In device mode, read the browser time zone each time instead of retaining the first observed offset. */
export function deviceTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : DEFAULT_CITY_TIME_ZONE;
  } catch {
    return DEFAULT_CITY_TIME_ZONE;
  }
}

export function resolveDisplayTimeZone(preference, deviceZone = deviceTimeZone()) {
  const next = normalizeDisplayTimezonePreference(preference);
  if (!next.followDevice) return next.cityTimeZone;
  return isValidTimeZone(deviceZone) ? deviceZone : DEFAULT_CITY_TIME_ZONE;
}

export function formatDisplayTime(timestamp, timeZone) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_CITY_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.month}-${value.day} ${value.hour}:${value.minute}`;
}
