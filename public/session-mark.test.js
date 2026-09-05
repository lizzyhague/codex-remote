import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, app, styles] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

test("the session row uses a pin toggle instead of an overflow menu", () => {
  assert.doesNotMatch(app, /session-menu-trigger/u);
  assert.doesNotMatch(app, /选择并整理/u);
  assert.match(app, /className = "session-mark-trigger quiet"/u);
  assert.match(app, /request\("session\.mark"/u);
  assert.match(app, /取消钉住/u);
});

test("recent sessions pin marked items above an untitled accent divider", () => {
  const render = app.slice(
    app.indexOf("function renderSessionList()"),
    app.indexOf("function createSessionItem("),
  );
  assert.match(render, /session-mark-group/u);
  assert.match(render, /session-mark-divider/u);
  assert.match(styles, /\.session-mark-divider\s*\{[^}]*border-top:\s*2px solid var\(--accent\)/su);
});

test("opening a marked session with a missing directory alerts and does not resume", () => {
  const resume = app.slice(
    app.indexOf("async function resumeSession("),
    app.indexOf("function applyOpenedSession("),
  );
  assert.match(resume, /directoryAvailable\(selected\.projectId\)/u);
  assert.match(resume, /showAlert\("这个会话的工作目录已经不在了。"/u);
  assert.ok(resume.indexOf("showAlert") < resume.indexOf("session.resume"));
  assert.match(html, /id="app-alert-dialog"/u);
});
