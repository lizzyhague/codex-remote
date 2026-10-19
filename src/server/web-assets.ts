import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const RELATIVE_IMPORT = /\b(?:import|from)\s+["']\.\/([^"'?#]+)(?:\?[^"']*)?["']/gu;
const VERSION = /^[a-f0-9]{64}$/u;
/** Besides the current version, retain several recent snapshots for old pages that remain open. */
export const RETAINED_PREVIOUS_VERSIONS = 2;
/** Remove staging directories left by crashes only after this age, avoiding ones another process may be writing. */
const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * Complete frontend snapshot confirmed at process startup. Regardless of later changes under `public/`, this process
 * serves only this set: page, scripts, styles, service worker, and icons stay pinned with the backend until restart.
 */
export class WebAssets {
  readonly #root: string;
  readonly #versioned: ReadonlySet<string>;
  readonly #version: string;
  readonly #files: ReadonlyMap<string, Buffer>;

  private constructor(root: string, versioned: ReadonlySet<string>, version: string, files: Map<string, Buffer>) {
    this.#root = root;
    this.#versioned = versioned;
    this.#version = version;
    this.#files = files;
  }

  /**
   * Read every allowlisted file, publish JS/CSS under `.web-assets/<hash>/`, and prune snapshots beyond retention.
   * Reject loading if a module dependency or page-referenced script is missing: fail startup instead of serving an incomplete set.
   */
  static async load(
    root: string,
    files: Iterable<string>,
    versionedFiles: Iterable<string>,
    options: { retainPrevious?: number } = {},
  ): Promise<WebAssets> {
    const versioned = new Set(versionedFiles);
    const contents = new Map<string, Buffer>();
    for (const file of [...new Set([...files, ...versioned])].sort()) {
      try {
        contents.set(file, await readFile(path.join(root, file)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(`Missing public asset: ${file}`, { cause: error });
      }
    }
    const entries = [...contents].filter(([file]) => versioned.has(file));
    for (const [file, body] of entries) {
      if (!file.endsWith(".js")) continue;
      for (const match of body.toString("utf8").matchAll(RELATIVE_IMPORT)) {
        const dependency = match[1]!;
        if (!versioned.has(dependency) || !contents.has(dependency)) {
          throw new Error(`Missing public asset: ${dependency} (imported by ${file})`);
        }
      }
    }
    const hash = createHash("sha256");
    for (const [file, body] of entries) {
      hash.update(file).update("\0").update(String(body.length)).update("\0").update(body);
    }
    const version = hash.digest("hex");

    // The service worker switches offline pages only after module dependencies are cached, so list the whole snapshot, not just direct HTML references.
    const assetList = entries.map(([file]) => `/assets/${version}/${file}`).join(",");
    for (const [file, body] of contents) {
      if (!file.endsWith(".html")) continue;
      const rewritten = body.toString("utf8").replace(
        /\b(src|href)="\/([^"?#]+)(?:\?[^"#]*)?"/gu,
        (original, attribute: string, target: string) => {
          if (!versioned.has(target)) return original;
          if (!contents.has(target)) throw new Error(`Missing public asset: ${target} (referenced by ${file})`);
          return `${attribute}="/assets/${version}/${target}"`;
        },
      );
      contents.set(file, Buffer.from(
        rewritten.replace("</head>", `<meta name="codex-remote-assets" content="${assetList}">\n</head>`),
      ));
    }

    const directory = path.join(root, ".web-assets");
    await publish(directory, version, entries);
    await prune(directory, version, options.retainPrevious ?? RETAINED_PREVIOUS_VERSIONS);
    return new WebAssets(root, versioned, version, contents);
  }

  get version(): string {
    return this.#version;
  }

  /** Files loaded at startup, with HTML rewritten to this version's asset URLs. Files absent at startup return null. */
  file(name: string): Buffer | null {
    return this.#files.get(name) ?? null;
  }

  /** Serve the current version from memory and retained disk versions to old pages. */
  async read(pathname: string): Promise<{ body: Buffer; file: string } | null> {
    const match = /^\/assets\/([a-f0-9]{64})\/([a-zA-Z0-9_.-]+)$/u.exec(pathname);
    if (!match || !this.#versioned.has(match[2]!)) return null;
    const [, version, file] = match as unknown as [string, string, string];
    if (version === this.#version) {
      const body = this.#files.get(file);
      return body ? { body, file } : null;
    }
    try {
      return { body: await readFile(path.join(this.#root, ".web-assets", version, file)), file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

async function publish(directory: string, version: string, entries: [string, Buffer][]): Promise<void> {
  const target = path.join(directory, version);
  let exists = false;
  try {
    exists = (await stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!exists) {
    await mkdir(directory, { recursive: true });
    // Write to staging before an atomic rename so other processes never read a partially written version directory.
    const staging = await mkdtemp(path.join(directory, ".staging-"));
    try {
      for (const [file, body] of entries) await writeFile(path.join(staging, file), body);
      try {
        await rename(staging, target);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  // Directory mtime records the latest startup as current; rolling back makes an old version newest again.
  const now = new Date();
  await utimes(target, now, now);
}

/** Retain the current version and several recent ones. Log pruning failures without blocking startup. */
async function prune(directory: string, current: string, retainPrevious: number): Promise<void> {
  try {
    const now = Date.now();
    const previous: { name: string; mtime: number }[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === current) continue;
      const mtime = (await stat(path.join(directory, entry.name))).mtimeMs;
      if (VERSION.test(entry.name)) previous.push({ name: entry.name, mtime });
      else if (entry.name.startsWith(".staging-") && now - mtime > STALE_STAGING_MS) {
        await rm(path.join(directory, entry.name), { recursive: true, force: true });
      }
    }
    previous.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    for (const { name } of previous.slice(retainPrevious)) {
      await rm(path.join(directory, name), { recursive: true, force: true });
    }
  } catch (error) {
    console.warn("Cleaning up old frontend snapshots failed", error);
  }
}
