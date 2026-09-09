import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DISPLAY_TIME_ZONES } from "./display-timezone.js";

const [html, app, styles, sw, httpServer] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
  readFile(new URL("./sw.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/http-server.ts", import.meta.url), "utf8"),
]);

const heading = html.slice(
  html.indexOf('<div class="sidebar-heading">'),
  html.indexOf('<div class="project-controls">'),
);
const appDialog = html.slice(
  html.indexOf('<dialog id="app-settings-dialog"'),
  html.indexOf("</dialog>", html.indexOf('<dialog id="app-settings-dialog"')),
);

test("the gear sits to the left of collapse and does not overlay the app icon", () => {
  assert.match(heading, /id="app-settings-button"/u);
  assert.match(heading, /aria-label="应用设置"/u);
  assert.match(heading, /title="应用设置"/u);
  assert.ok(heading.indexOf('id="app-settings-button"') < heading.indexOf('id="collapse-sidebar-button"'));
  assert.ok(heading.indexOf('class="sidebar-brand"') < heading.indexOf('id="app-settings-button"'));
  assert.match(heading, /class="sidebar-logo"/u);
  assert.doesNotMatch(
    heading.slice(heading.indexOf("sidebar-brand"), heading.indexOf("sidebar-heading-actions")),
    /app-settings-button/u,
  );
  const buttonRule = styles.slice(
    styles.indexOf("button.app-settings-button {"),
    styles.indexOf("}", styles.indexOf("button.app-settings-button {")),
  );
  assert.match(buttonRule, /padding:\s*0;/u);
});

test("application settings is a small timezone-only dialog", () => {
  assert.match(appDialog, /<h2 id="app-settings-title">应用设置<\/h2>/u);
  assert.match(appDialog, />跟随设备</u);
  assert.match(appDialog, />城市</u);
  assert.match(appDialog, /仅影响这台设备上的时间显示，自动考虑夏令时。/u);
  assert.doesNotMatch(appDialog, /照面/u);
  assert.doesNotMatch(appDialog, /主题/u);
  for (const city of DISPLAY_TIME_ZONES) {
    assert.match(appDialog, new RegExp(`<option value="${city.id}">${city.label}</option>`));
  }
});

test("follow-device disables the city select and keeps the previous city", () => {
  assert.match(app, /displayTimezoneCitySelect\.disabled = prefs\.followDevice/u);
  assert.match(app, /followDevice: elements\.followDeviceTimezoneInput\.checked/u);
  assert.match(app, /cityTimeZone: elements\.displayTimezoneCitySelect\.value/u);
  assert.match(styles, /\.application-settings-row select:disabled\s*\{[^}]*opacity:\s*0\.45;/su);
});

test("page times use the local display preference instead of the host clock", () => {
  assert.match(app, /from "\.\/display-timezone\.js\?v=1"/u);
  assert.match(app, /resolveDisplayTimeZone\(state\.displayTimezone, deviceTimeZone\(\)\)/u);
  assert.match(app, /refreshDisplayedTimes\(\)/u);
  assert.match(app, /loadDisplayTimezonePreference\(\)/u);
  assert.match(app, /value < 1_000_000_000_000 \? value \* 1_000 : value/u);
  assert.doesNotMatch(app, /date\.getHours\(\)/u);
  assert.match(httpServer, /"\/display-timezone\.js"/u);
  assert.match(sw, /\/display-timezone\.js\?v=1/u);
  assert.match(html, /styles\.css\?v=29/u);
  assert.match(html, /app\.js\?v=34/u);
});
