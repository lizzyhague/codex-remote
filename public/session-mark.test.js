import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { localize, t } from "./i18n.test-support.js";

const [html, app, styles] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

test("the session row uses a pin toggle instead of an overflow menu", () => {
  assert.doesNotMatch(app, /session-menu-trigger/u);
  assert.doesNotMatch(app, /选择并整理/u);
  assert.match(app, /className = "session-rename-trigger quiet"/u);
  assert.match(app, /className = "session-mark-trigger quiet"/u);
  assert.match(app, /request\("session\.mark"/u);
  assert.match(app, /t\("sessions\.unpin"\)/u);
});

test("only recent session rows show the rename button before the pin", () => {
  const create = app.slice(
    app.indexOf("function createSessionItem("),
    app.indexOf("function appendSessionText("),
  );
  assert.match(create, /state\.sessionView === "active"\) item\.append\(createSessionRename\(session\)\)/u);
  assert.ok(create.indexOf("createSessionRename(session)") < create.indexOf("createSessionMark(session)"));
});

test("recent sessions pin marked items above an untitled accent divider", () => {
  const render = app.slice(
    app.indexOf("function renderSessionList()"),
    app.indexOf("function createSessionItem("),
  );
  assert.match(render, /session-mark-group/u);
  assert.match(render, /session-mark-divider/u);
  assert.match(styles, /\.session-mark-divider\s*\{[^}]*border-top:\s*1\.5px solid var\(--divider-accent\)/su);
});

test("pinning an unmarked session opens the rename dialog", () => {
  const create = app.slice(
    app.indexOf("function createSessionMark("),
    app.indexOf("function sessionMarkIcon("),
  );
  assert.match(create, /void toggleSessionMark\(session\)/u);
  assert.match(create, /if \(!session\.marked\) openRenameDialog\(session\)/u);
  assert.match(app, /request\("session\.rename"/u);
  assert.doesNotMatch(app, /dialog\.dataset\.sessionId !== state\.sessionId/u);
});

test("an untitled session shows its default name only as a placeholder when renaming", () => {
  const open = app.slice(app.indexOf("function openRenameDialog("), app.indexOf("elements.renameCancelButton"));
  assert.match(open, /input\.value = fromSession\.title \|\| "";/u);
  assert.match(open, /input\.placeholder = t\("session\.untitled"\);/u);
  assert.doesNotMatch(app, /sessionTitle = [^;\n]*t\("session\.untitled"\)/u);
});

test("opening a marked session with a missing directory alerts and does not resume", () => {
  const resume = app.slice(
    app.indexOf("async function resumeSession("),
    app.indexOf("function applyOpenedSession("),
  );
  assert.match(resume, /directoryAvailable\(selected\.projectId\)/u);
  assert.match(resume, /showAlert\(t\("session\.directoryGone"\)/u);
  assert.ok(resume.indexOf("showAlert") < resume.indexOf("session.resume"));
  assert.match(html, /id="app-alert-dialog"/u);
});
