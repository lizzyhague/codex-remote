import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RETAINED_PREVIOUS_VERSIONS, WebAssets } from "./web-assets.ts";

const FILES = [
  "boot.js",
  "app.js",
  "markdown.js",
  "mcp-form.js",
  "styles.css",
  "viewer.js",
  "viewer.css",
];
const PAGE = '<head><script type="module" src="/app.js"></script><link href="/styles.css" rel="stylesheet"></head>';

async function fixture(t: test.TestContext, files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-web-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contents = {
    "index.html": PAGE,
    "boot.js": "// boot",
    "app.js": 'import { render } from "./markdown.js";\nwindow.__PWA_MARK__ = "A";',
    "markdown.js": 'export const render = () => "mark-A";',
    "mcp-form.js": "export const validate = () => true;",
    "styles.css": "body { color: red }",
    "viewer.js": 'import { render } from "./markdown.js";',
    "viewer.css": ".file-viewer { color: blue }",
    ...files,
  };
  for (const [name, body] of Object.entries(contents)) {
    await writeFile(path.join(root, name), body);
  }
  return root;
}

function load(root: string, options?: { retainPrevious?: number }) {
  return WebAssets.load(root, ["index.html", "icon.svg", ...FILES], FILES, options);
}

function page(assets: WebAssets): string {
  return assets.file("index.html")!.toString("utf8");
}

function assetUrl(html: string, file: string): string {
  const match = html.match(new RegExp(`(?:src|href)="(/assets/[a-f0-9]{64}/${file})"`));
  assert.ok(match, `missing versioned ${file}`);
  return match[1]!;
}

async function versions(root: string): Promise<string[]> {
  return (await readdir(path.join(root, ".web-assets"))).filter((name) => !name.startsWith(".")).sort();
}

test("rewrites local scripts and styles and lists transitive module imports", async (t) => {
  const root = await fixture(t, {
    "index.html": `${PAGE}<img src="/icon-192.png"><a href="/view?path=/tmp/note.md">view</a>`,
  });
  const html = page(await load(root));
  assert.match(html, /src="\/assets\/[a-f0-9]{64}\/app\.js"/u);
  assert.match(html, /href="\/assets\/[a-f0-9]{64}\/styles\.css"/u);
  assert.match(html, /<meta name="codex-remote-assets" content="[^"]*markdown\.js/u);
  assert.match(html, /src="\/icon-192\.png"/u);
  assert.match(html, /href="\/view\?path=\/tmp\/note\.md"/u);
  assert.doesNotMatch(html, /href="\/assets\/[^"]+\/icon-192\.png"/u);
});

test("a loaded snapshot ignores later source edits; the next load publishes a new version beside it", async (t) => {
  const root = await fixture(t);
  const first = await load(root);
  const firstApp = assetUrl(page(first), "app.js");
  const firstModule = new URL("./markdown.js", `https://example.test${firstApp}`).pathname;

  await writeFile(path.join(root, "markdown.js"), 'export const render = () => "mark-B";');
  await writeFile(path.join(root, "index.html"), `${PAGE}edited`);
  await writeFile(path.join(root, "icon.svg"), "<svg>new</svg>");
  // 运行中的一套不变：页面、当前版本资源、未版本化文件都是启动时的内容。
  assert.equal(assetUrl(page(first), "app.js"), firstApp);
  assert.doesNotMatch(page(first), /edited/u);
  assert.match((await first.read(firstModule))!.body.toString("utf8"), /mark-A/u);
  assert.equal(first.file("icon.svg"), null);
  assert.deepEqual(await versions(root), [first.version]);

  const second = await load(root);
  const secondApp = assetUrl(page(second), "app.js");
  assert.notEqual(secondApp, firstApp);
  assert.match(page(second), /edited/u);
  assert.equal(second.file("icon.svg")!.toString("utf8"), "<svg>new</svg>");
  assert.match((await second.read(new URL("./markdown.js", `https://example.test${secondApp}`).pathname))!.body.toString("utf8"), /mark-B/u);
  assert.match((await second.read(firstModule))!.body.toString("utf8"), /mark-A/u);
});

test("the current version is served from memory even if its directory disappears", async (t) => {
  const root = await fixture(t);
  const assets = await load(root);
  const url = assetUrl(page(assets), "app.js");
  await rm(path.join(root, ".web-assets"), { recursive: true, force: true });
  assert.match((await assets.read(url))!.body.toString("utf8"), /__PWA_MARK__/u);
});

test("refuses to load a snapshot that is missing a module import or a page script", async (t) => {
  const missingImport = await fixture(t, { "app.js": 'import { render } from "./missing.js";' });
  await assert.rejects(load(missingImport), /Missing public asset: missing\.js/u);
  await assert.rejects(readdir(path.join(missingImport, ".web-assets")), { code: "ENOENT" });

  const missingScript = await fixture(t);
  await rm(path.join(missingScript, "styles.css"));
  await assert.rejects(load(missingScript), /Missing public asset: styles\.css \(referenced by index\.html\)/u);
});

test("concurrent loads of the same files do not leave a partial snapshot", async (t) => {
  const root = await fixture(t);
  const [one, two] = await Promise.all([load(root), load(root)]);
  assert.equal(page(one), page(two));
  assert.deepEqual(await versions(root), [one.version]);
  const published = await readdir(path.join(root, ".web-assets", one.version));
  assert.deepEqual([...published].sort(), [...FILES].sort());
});

test("keeps the current version and the most recent previous ones, and cleans stale staging", async (t) => {
  const root = await fixture(t);
  const hour = 60 * 60 * 1000;
  const released: WebAssets[] = [];
  for (let release = 0; release < RETAINED_PREVIOUS_VERSIONS + 3; release += 1) {
    await writeFile(path.join(root, "boot.js"), `// boot ${release}`);
    const assets = await load(root);
    released.push(assets);
    // 让每次发布的时间先后明确，不依赖文件系统时间戳精度。
    const at = new Date(Date.now() - (10 - release) * hour);
    await utimes(path.join(root, ".web-assets", assets.version), at, at);
  }
  const directory = path.join(root, ".web-assets");
  const stale = path.join(directory, ".staging-stale");
  const fresh = path.join(directory, ".staging-fresh");
  await mkdir(stale);
  await mkdir(fresh);
  const old = new Date(Date.now() - 2 * hour);
  await utimes(stale, old, old);
  await writeFile(path.join(directory, "README"), "not a version");

  await writeFile(path.join(root, "boot.js"), "// boot current");
  const current = await load(root);
  const expected = [current.version, ...released.slice(-RETAINED_PREVIOUS_VERSIONS).map((assets) => assets.version)];
  assert.deepEqual(await versions(root), [...expected, "README"].sort());
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".")), [".staging-fresh"]);

  // 被回收的旧版本不再提供，也不会回落到当前文件；仍保留的旧版本可取。
  assert.equal(await current.read(assetUrl(page(released[0]!), "app.js")), null);
  assert.ok(await current.read(assetUrl(page(released.at(-1)!), "app.js")));

  // 回退到较早的版本时，它重新算作最近启动的版本，不会被当成最旧的删掉。
  await writeFile(path.join(root, "boot.js"), `// boot ${RETAINED_PREVIOUS_VERSIONS + 1}`);
  const rolledBack = await load(root, { retainPrevious: 1 });
  assert.equal(rolledBack.version, released.at(-2)!.version);
  assert.deepEqual(await versions(root), [rolledBack.version, current.version, "README"].sort());
});

test("unknown versions, unknown files and path traversal do not fall back to current files", async (t) => {
  const assets = await load(await fixture(t));
  const current = assetUrl(page(assets), "app.js");
  assert.equal(await assets.read(`/assets/${"0".repeat(64)}/app.js`), null);
  assert.equal(await assets.read(current.replace("app.js", "config.json")), null);
  assert.equal(await assets.read(`/assets/${"a".repeat(64)}/%2e%2e%2fapp.js`), null);
  assert.notEqual((await assets.read(current))!.body.toString("utf8"), "");
});

test("read surfaces storage failures of an older snapshot instead of pretending it is missing", async (t) => {
  const root = await fixture(t);
  const previous = await load(root);
  const url = assetUrl(page(previous), "app.js");
  await writeFile(path.join(root, "boot.js"), "// boot next");
  const current = await load(root);
  const filePath = path.join(root, ".web-assets", previous.version, "app.js");
  await chmod(filePath, 0);
  try {
    await assert.rejects(current.read(url), (error: NodeJS.ErrnoException) => error.code === "EACCES");
  } finally {
    await chmod(filePath, 0o644);
  }
});
