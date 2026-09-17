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

test("application settings keeps timezone controls and does not copy companion-only chrome", () => {
  assert.match(appDialog, /<h2 id="app-settings-title">应用设置<\/h2>/u);
  assert.match(appDialog, />跟随设备</u);
  assert.match(appDialog, />城市</u);
  assert.match(appDialog, /仅影响这台设备上的时间显示，自动考虑夏令时。/u);
  assert.doesNotMatch(appDialog, /照面/u);
  assert.doesNotMatch(appDialog, /主题/u);
  assert.doesNotMatch(appDialog, /给伴的话/u);
  assert.doesNotMatch(appDialog, /role="tablist"/u);
  for (const city of DISPLAY_TIME_ZONES) {
    assert.match(appDialog, new RegExp(`<option value="${city.id}">${city.label}</option>`));
  }
});

test("developer instructions sit in the app-settings dialog with companion field patterns", () => {
  assert.match(appDialog, />附加 Developer 指令</u);
  assert.match(
    appDialog,
    /用于补充 Codex 的协作方式；在新建或重新载入会话时生效。/u,
  );
  assert.match(
    appDialog,
    /placeholder="输入希望 Codex 始终遵循的附加指令……"/u,
  );
  assert.match(
    appDialog,
    /id="developer-instructions-input"[^>]*rows="5"[^>]*maxlength="131072"/u,
  );
  assert.match(
    appDialog,
    /<label for="developer-instructions-input">附加 Developer 指令<\/label><button /u,
  );
  assert.match(
    appDialog,
    /class="field-info" popovertarget="info-developer-instructions" aria-label="关于附加 Developer 指令的说明"/u,
  );
  assert.match(
    appDialog,
    /id="info-developer-instructions" class="field-info-popover" popover/u,
  );
  const start = appDialog.indexOf('<div id="info-developer-instructions"');
  const info = appDialog.slice(start, appDialog.indexOf("</div>", start));
  const paragraphs = [...info.matchAll(/<p>(.*?)<\/p>/gsu)]
    .map((match) => match[1].replace(/<[^>]+>/gu, ""));
  assert.deepEqual(paragraphs, [
    "这段内容由 Codex Remote 后端保存。连到同一后端的设备共用这一份；不同后端之间不会同步。",
    "新建或重新载入会话时，会通过 Codex App Server 的 developerInstructions 注入。",
    "Developer 指令的优先级高于用户消息。",
    "它不会替换 Codex 自带的基础指令，也不能用来控制完整的系统提示词。",
    "留空时只使用 Codex Remote 内置的 Developer 指令。改动不会影响已经在运行的任务。",
  ]);
  assert.doesNotMatch(appDialog, /baseInstructions/u);
});

test("the save row sits outside the scrolling area and the dialog body is the only scroller", () => {
  assert.match(
    styles,
    /\.application-settings-card\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto;/su,
  );
  assert.match(styles, /\.application-settings-body\s*\{[^}]*overflow-y:\s*auto;/su);
  assert.match(styles, /\.application-settings-dialog\s*\{[^}]*overflow:\s*hidden;/su);
  assert.match(styles, /\.application-settings-dialog\[open\]\s*\{\s*display:\s*flex;/su);
  assert.ok(appDialog.indexOf('class="application-settings-body"') <
    appDialog.indexOf('class="application-settings-footer"'));
  assert.ok(appDialog.indexOf('id="app-settings-save-button"') >
    appDialog.indexOf('class="application-settings-footer"'));
  assert.match(styles, /@media \(max-width: 640px\)\s*\{[^}]*\.application-settings-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 0\.75rem\);/su);
});

test("ⓘ is declarative, does not wrap the textarea, and hides when closed", () => {
  assert.match(
    styles,
    /\.field-info\[popovertarget="info-developer-instructions"\]\s*\{\s*anchor-name:\s*--info-developer-instructions;/u,
  );
  assert.match(
    styles,
    /#info-developer-instructions\s*\{\s*position-anchor:\s*--info-developer-instructions;/u,
  );
  assert.match(styles, /\.application-settings-body\s*\{[^}]*anchor-name:\s*--application-settings-body;/su);
  assert.match(styles, /\.field-info-popover:not\(:popover-open\)\s*\{\s*display:\s*none;/su);
  assert.doesNotMatch(appDialog, /<label class="[^"]*"[^>]*>[\s\S]*field-info[\s\S]*developer-instructions-input/u);
});

test("opening reloads backend settings; events skip an open dirty form", () => {
  assert.match(app, /request\("settings\.get"\)/u);
  assert.match(app, /request\("settings\.update", \{\s*developerInstructions:/u);
  assert.match(app, /async function openAppSettings\(\)/u);
  assert.match(app, /function applySettingsUpdated\(/u);
  assert.match(app, /preserveForm = dialogOpen && \(state\.appSettingsBusy \|\| developerInstructionsDirty\(\)\)/u);
  assert.match(app, /if \(dialogOpen && !preserveForm\)/u);
  assert.match(app, /case "settings\.updated":/u);
  const open = app.slice(
    app.indexOf("async function openAppSettings()"),
    app.indexOf("function closeAppSettings()"),
  );
  assert.match(open, /await loadDeveloperInstructions\(\)/u);
  assert.ok(open.indexOf("await loadDeveloperInstructions()") < open.indexOf("showModal()"));
  assert.match(open, /if \(!elements\.appSettingsDialog\.open\) elements\.appSettingsDialog\.showModal\(\)/u);
  const load = app.slice(
    app.indexOf("async function loadDeveloperInstructions()"),
    app.indexOf("async function saveAppSettings()"),
  );
  assert.match(load, /catch \(error\) \{\s*setAppSettingsStatus\(errorMessage\(error\), "error"\);/su);
  assert.ok(load.indexOf("elements.developerInstructionsInput.value = value") < load.indexOf("} catch"));
});

test("save disables controls, closes on success, and leaves errors in the dialog", () => {
  assert.match(app, /setAppSettingsStatus\("正在保存……"\)/u);
  assert.match(app, /updateAppSettingsControls\(\)/u);
  assert.match(app, /elements\.appSettingsDialog\.close\(\)/u);
  assert.match(app, /setAppSettingsStatus\(errorMessage\(error\), "error"\)/u);
  assert.match(app, /if \(state\.appSettingsBusy\) event\.preventDefault\(\)/u);
  assert.match(appDialog, /id="app-settings-status"[^>]*aria-live="polite"/u);
  assert.match(appDialog, />取消</u);
  assert.match(appDialog, />保存</u);
  const save = app.slice(app.indexOf("async function saveAppSettings()"), app.indexOf("function setAppSettingsStatus("));
  assert.match(save, /state\.appSettingsBusy = true/u);
  assert.match(save, /elements\.appSettingsDialog\.close\(\)/u);
  assert.match(save, /catch \(error\) \{\s*setAppSettingsStatus\(errorMessage\(error\), "error"\);/su);
  assert.ok(save.indexOf("elements.appSettingsDialog.close()") < save.indexOf("} catch"));
});

test("follow-device disables the city select and keeps the previous city", () => {
  assert.match(app, /displayTimezoneCitySelect\.disabled = prefs\.followDevice/u);
  assert.match(app, /followDevice: elements\.followDeviceTimezoneInput\.checked/u);
  assert.match(app, /cityTimeZone: elements\.displayTimezoneCitySelect\.value/u);
  assert.match(styles, /\.application-settings-row select:disabled\s*\{[^}]*opacity:\s*0\.45;/su);
});

test("page times use the local display preference instead of the host clock", () => {
  assert.match(app, /from "\.\/display-timezone\.js"/u);
  assert.match(app, /resolveDisplayTimeZone\(state\.displayTimezone, deviceTimeZone\(\)\)/u);
  assert.match(app, /refreshDisplayedTimes\(\)/u);
  assert.match(app, /loadDisplayTimezonePreference\(\)/u);
  assert.match(app, /value < 1_000_000_000_000 \? value \* 1_000 : value/u);
  assert.doesNotMatch(app, /date\.getHours\(\)/u);
  assert.match(httpServer, /"\/display-timezone\.js"/u);
  assert.match(sw, /codex-remote-assets/u);
  assert.match(html, /href="\/styles\.css"/u);
  assert.match(html, /src="\/app\.js"/u);
  assert.doesNotMatch(html, /\.(?:js|css)\?v=/u);
});
