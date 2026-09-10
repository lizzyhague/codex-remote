import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [boot, app, styles] = await Promise.all([
  readFile(new URL("./boot.js", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

test("service worker registration stays in boot.js and does not auto-reload", () => {
  assert.match(boot, /navigator\.serviceWorker\.register\("\/sw\.js", \{ updateViaCache: "none" \}\)/u);
  assert.match(boot, /codexRemoteReady/u);
  assert.match(boot, /codexRemoteMarkReady/u);
  assert.doesNotMatch(app, /serviceWorker/u);
  assert.doesNotMatch(boot, /skipWaiting|controllerchange/u);
});

test("pull-to-refresh uses the same surfaces and copy as Relayu", () => {
  assert.match(boot, /closest\("\.timeline, \.session-list, \.app-header, \.login-view"\)/u);
  assert.match(boot, /下拉刷新/u);
  assert.match(boot, /松开刷新/u);
  assert.match(boot, /window\.location\.reload\(\)/u);
  assert.match(boot, /ontouchstart/u);
  assert.match(styles, /html\.pull-refresh-enabled/u);
  assert.match(styles, /\.pull-refresh\s*\{/u);
});
