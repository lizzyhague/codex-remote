import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const RELATIVE_IMPORT = /\b(?:import|from)\s+["']\.\/([^"'?#]+)(?:\?[^"']*)?["']/gu;
const VERSION = /^[a-f0-9]{64}$/u;
/** 除当前版本外，磁盘上再保留最近发布的几套旧快照，供仍打开的旧页面取资源。 */
export const RETAINED_PREVIOUS_VERSIONS = 2;
/** 进程崩溃留下的 staging 目录超过这个时间才清理，不碰别的进程正在写的。 */
const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * 进程启动时确认的整套前端。之后工作树里的 `public/` 怎么变，这个进程都只提供这一套：
 * 页面、脚本、样式、SW 和图标一起跟后端代码固定成一个版本，重启才整体换新。
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
   * 读入白名单里的全部文件，把 JS/CSS 发布成 `.web-assets/<hash>/`，并回收超出保留数的旧快照。
   * 模块依赖或页面引用的脚本缺失时拒绝加载：宁可不启动，也不对外提供不完整的一套。
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

    // SW 要等模块依赖也进缓存后才切换离线页，所以清单含整套快照，不只是 HTML 直接引用。
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

  /** 启动时读入的文件；HTML 已改写成本版本的资源地址。启动时不存在的文件返回 null。 */
  file(name: string): Buffer | null {
    return this.#files.get(name) ?? null;
  }

  /** 当前版本从内存取；仍保留在磁盘上的旧版本给旧页面用。 */
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
    // 先写 staging 再整体改名，别的进程不会读到写到一半的版本目录。
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
  // 目录修改时间记录“最近一次作为当前版本启动”，回退到旧版本时它也重新算作最新。
  const now = new Date();
  await utimes(target, now, now);
}

/** 保留当前版本和最近的若干旧版本。回收失败只记日志，不挡启动。 */
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
    console.warn("旧前端快照清理失败", error);
  }
}
