import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebAssets } from "./web-assets.ts";

const FILES = ["boot.js", "app.js", "markdown.js", "styles.css", "viewer.js", "viewer.css"];

async function fixture(t: test.TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-web-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = {
    "boot.js": "// boot",
    "app.js": 'import { render } from "./markdown.js";\nwindow.__PWA_MARK__ = "A";',
    "markdown.js": 'export const render = () => "mark-A";',
    "styles.css": "body { color: red }",
    "viewer.js": 'import { render } from "./markdown.js";',
    "viewer.css": ".file-viewer { color: blue }",
    ...files,
  };
  for (const [name, body] of Object.entries(contents)) {
    await writeFile(path.join(root, name), body);
  }
  return { root, assets: new WebAssets(root, FILES) };
}

function assetUrl(html: string, file: string): string {
  const match = html.match(new RegExp(`(?:src|href)="(/assets/[a-f0-9]{64}/${file})"`));
  assert.ok(match, `missing versioned ${file}`);
  return match[1]!;
}

test("rewrites local scripts and styles and lists transitive module imports", async (t) => {
  const { assets } = await fixture(t);
  const html = (await assets.page(Buffer.from(
    '<head><script type="module" src="/app.js"></script><link href="/styles.css" rel="stylesheet"></head><img src="/icon-192.png"><a href="/view?path=/tmp/note.md">view</a>',
  ))).toString("utf8");
  assert.match(html, /src="\/assets\/[a-f0-9]{64}\/app\.js"/u);
  assert.match(html, /href="\/assets\/[a-f0-9]{64}\/styles\.css"/u);
  assert.match(html, /<meta name="codex-remote-assets" content="[^"]*markdown\.js/u);
  assert.match(html, /src="\/icon-192\.png"/u);
  assert.match(html, /href="\/view\?path=\/tmp\/note\.md"/u);
  assert.doesNotMatch(html, /href="\/assets\/[^"]+\/icon-192\.png"/u);
});

test("unchanged files reuse a snapshot; a dependency-only change moves every entry URL", async (t) => {
  const { root, assets } = await fixture(t);
  const first = (await assets.page(Buffer.from('<head><script src="/app.js"></script></head>'))).toString("utf8");
  const firstApp = assetUrl(first, "app.js");
  const second = (await assets.page(Buffer.from('<head><script src="/app.js"></script></head>'))).toString("utf8");
  assert.equal(assetUrl(second, "app.js"), firstApp);
  await writeFile(path.join(root, "markdown.js"), 'export const render = () => "mark-B";');
  const third = (await assets.page(Buffer.from('<head><script src="/app.js"></script></head>'))).toString("utf8");
  const nextApp = assetUrl(third, "app.js");
  assert.notEqual(nextApp, firstApp);
  assert.equal(await (await assets.read(firstApp))!.body.toString("utf8"), await readFile(path.join(root, "app.js"), "utf8"));
  assert.match((await assets.read(new URL("./markdown.js", `https://example.test${firstApp}`).pathname))!.body.toString("utf8"), /mark-A/u);
  assert.match((await assets.read(new URL("./markdown.js", `https://example.test${nextApp}`).pathname))!.body.toString("utf8"), /mark-B/u);
});

test("refuses to publish a snapshot that is missing a module import", async (t) => {
  const { assets } = await fixture(t, {
    "app.js": 'import { render } from "./missing.js";',
  });
  await assert.rejects(
    assets.page(Buffer.from('<head><script src="/app.js"></script></head>')),
    /Missing public asset: missing\.js/u,
  );
});

test("concurrent page() calls do not leave a partial snapshot", async (t) => {
  const { root, assets } = await fixture(t);
  const html = Buffer.from('<head><script src="/app.js"></script></head>');
  const [one, two] = await Promise.all([assets.page(html), assets.page(html)]);
  assert.equal(one.toString("utf8"), two.toString("utf8"));
  const versions = await readdir(path.join(root, ".web-assets"));
  assert.equal(versions.filter((name) => !name.startsWith(".")).length, 1);
  const version = versions.find((name) => !name.startsWith("."))!;
  const published = await readdir(path.join(root, ".web-assets", version));
  assert.deepEqual([...published].sort(), [...FILES].sort());
});

test("unknown versions, unknown files and path traversal do not fall back to current files", async (t) => {
  const { assets } = await fixture(t);
  const html = (await assets.page(Buffer.from('<head><script src="/app.js"></script></head>'))).toString("utf8");
  const current = assetUrl(html, "app.js");
  assert.equal(await assets.read(`/assets/${"0".repeat(64)}/app.js`), null);
  assert.equal(await assets.read(current.replace("app.js", "config.json")), null);
  assert.equal(await assets.read(`/assets/${"a".repeat(64)}/%2e%2e%2fapp.js`), null);
  assert.notEqual((await assets.read(current))!.body.toString("utf8"), "");
});

test("read surfaces storage failures instead of pretending the file is missing", async (t) => {
  const { root, assets } = await fixture(t);
  const html = (await assets.page(Buffer.from('<head><script src="/app.js"></script></head>'))).toString("utf8");
  const url = assetUrl(html, "app.js");
  const filePath = path.join(root, ".web-assets", url.split("/")[2]!, "app.js");
  await chmod(filePath, 0);
  try {
    await assert.rejects(assets.read(url), (error: NodeJS.ErrnoException) => error.code === "EACCES");
  } finally {
    await chmod(filePath, 0o644);
  }
});
