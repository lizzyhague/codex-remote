import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

/** 测试专用：在 `node:fs/promises` 默认对象上注入故障，记录原子写各阶段的调用顺序。 */
export type FsStage =
  | "file-write"
  | "file-sync"
  | "file-close"
  | "rename"
  | "directory-sync";

export type FsFaultPlan = {
  /** 每个阶段第几次调用（从 1 开始）时抛错；`"always"` 表示每次都抛。 */
  fail?: Partial<Record<FsStage, number | "always">>;
};

export type FsFaultRecorder = {
  /** 按发生顺序记录的阶段，目录同步带目录名：`directory-sync:<path>`。 */
  readonly events: string[];
  /** 之后不再注入任何故障，用来验证失败后可以重试。 */
  heal(): void;
};

export function injectFsFaults(context: TestContext, plan: FsFaultPlan = {}): FsFaultRecorder {
  const counts = new Map<FsStage, number>();
  const events: string[] = [];
  let healed = false;

  const shouldFail = (stage: FsStage): boolean => {
    const count = (counts.get(stage) ?? 0) + 1;
    counts.set(stage, count);
    const rule = plan.fail?.[stage];
    if (healed || rule === undefined) return false;
    return rule === "always" || rule === count;
  };
  const fault = (stage: FsStage) =>
    Object.assign(new Error(`injected ${stage} failure`), { code: "EIO" });

  const realOpen = fs.open.bind(fs);
  const realRename = fs.rename.bind(fs);

  context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const target = String(args[0]);
    const stat = await handle.stat();
    return stat.isDirectory() ? wrapDirectory(handle, target) : wrapFile(handle);
  });
  context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    events.push("rename");
    if (shouldFail("rename")) throw fault("rename");
    return realRename(...args);
  });

  function wrapFile(handle: FileHandle): FileHandle {
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "writeFile") {
          return async (...args: Parameters<FileHandle["writeFile"]>) => {
            events.push("file-write");
            if (shouldFail("file-write")) {
              // 模拟写到一半：已有部分私有数据进入临时文件。
              await target.writeFile("{\"partial\":", "utf8");
              throw fault("file-write");
            }
            return target.writeFile(...args);
          };
        }
        if (property === "sync") {
          return async () => {
            events.push("file-sync");
            if (shouldFail("file-sync")) throw fault("file-sync");
            return target.sync();
          };
        }
        if (property === "close") {
          return async () => {
            events.push("file-close");
            if (shouldFail("file-close")) {
              // 描述符照常关闭，只把失败报给调用方，避免测试泄漏 fd。
              await target.close();
              throw fault("file-close");
            }
            return target.close();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function wrapDirectory(handle: FileHandle, directory: string): FileHandle {
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === "sync") {
          return async () => {
            events.push(`directory-sync:${path.resolve(directory)}`);
            if (shouldFail("directory-sync")) throw fault("directory-sync");
            return target.sync();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return {
    events,
    heal() {
      healed = true;
    },
  };
}

/** 目录里残留的原子写临时文件。 */
export async function temporaryFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
}
