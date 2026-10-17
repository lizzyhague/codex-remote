import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

/** Tests only: inject faults into the default `node:fs/promises` object and record each atomic-write stage in call order. */
export type FsStage =
  | "file-write"
  | "file-sync"
  | "file-close"
  | "rename"
  | "directory-sync";

export type FsFaultPlan = {
  /** One-based invocation number on which each stage throws; `"always"` throws every time. */
  fail?: Partial<Record<FsStage, number | "always">>;
};

export type FsFaultRecorder = {
  /** Stages in occurrence order; directory sync includes its path as `directory-sync:<path>`. */
  readonly events: string[];
  /** Stop injecting faults, used to verify that an operation can be retried after failure. */
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
              // Simulate a partial write with some private data already in the temporary file.
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
              // Close the descriptor normally and report only the failure to the caller, avoiding leaked FDs in tests.
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

/** Atomic-write temporary files left behind in the directory. */
export async function temporaryFiles(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"));
}
