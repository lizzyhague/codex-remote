import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const RELATIVE_IMPORT = /\b(?:import|from)\s+["']\.\/([^"'?#]+)(?:\?[^"']*)?["']/gu;

/** 页面脚本和样式的整套快照。没有单独的前端构建命令。 */
export class WebAssets {
  readonly #root: string;
  readonly #files: ReadonlySet<string>;
  #publishing: Promise<void> = Promise.resolve();

  constructor(root: string, files: Iterable<string>) {
    this.#root = root;
    this.#files = new Set(files);
  }

  async page(html: Buffer): Promise<Buffer> {
    // 只收 HTTP 白名单里的脚本和样式，不扫描整个 public/。
    const entries: [string, Buffer][] = [];
    for (const file of [...this.#files].sort()) {
      try {
        entries.push([file, await readFile(path.join(this.#root, file))]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const available = new Set(entries.map(([file]) => file));
    for (const [file, body] of entries) {
      if (!file.endsWith(".js")) continue;
      for (const match of body.toString("utf8").matchAll(RELATIVE_IMPORT)) {
        const dependency = match[1]!;
        if (!this.#files.has(dependency) || !available.has(dependency)) {
          throw new Error(`Missing public asset: ${dependency} (imported by ${file})`);
        }
      }
    }
    const hash = createHash("sha256");
    for (const [file, body] of entries) {
      hash.update(file).update("\0").update(String(body.length)).update("\0").update(body);
    }
    const version = hash.digest("hex");
    const directory = path.join(this.#root, ".web-assets", version);
    // 串行发布，避免请求拿到写到一半的目录。
    const publish = this.#publishing.then(async () => {
      try {
        if ((await stat(directory)).isDirectory()) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(directory), { recursive: true });
      const staging = await mkdtemp(path.join(path.dirname(directory), ".staging-"));
      try {
        for (const [file, body] of entries) await writeFile(path.join(staging, file), body);
        try {
          await rename(staging, directory);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            throw error;
          }
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
    this.#publishing = publish.catch(() => {});
    await publish;

    const rewritten = html.toString("utf8").replace(
      /\b(src|href)="\/([^"?#]+)(?:\?[^"#]*)?"/gu,
      (original, attribute: string, file: string) => {
        if (!this.#files.has(file)) return original;
        if (!available.has(file)) throw new Error(`Missing public asset: ${file}`);
        return `${attribute}="/assets/${version}/${file}"`;
      },
    );
    // SW 要等模块依赖也进缓存后才切换离线页，所以清单含整套快照，不只是 HTML 直接引用。
    const assetList = entries.map(([file]) => `/assets/${version}/${file}`).join(",");
    return Buffer.from(
      rewritten.replace("</head>", `<meta name="codex-remote-assets" content="${assetList}">\n</head>`),
    );
  }

  async read(pathname: string): Promise<{ body: Buffer; file: string } | null> {
    const match = /^\/assets\/([a-f0-9]{64})\/([a-zA-Z0-9_.-]+)$/u.exec(pathname);
    if (!match || !this.#files.has(match[2]!)) return null;
    try {
      return {
        body: await readFile(path.join(this.#root, ".web-assets", match[1]!, match[2]!)),
        file: match[2]!,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}
