import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MANIFEST_NAME = "codex-protocol.json";
const EXPECTED_OUTPUT_DIRECTORY = "src/generated";

export type CodexProtocolManifest = {
  codexCliVersion: string;
  outputDirectory: typeof EXPECTED_OUTPUT_DIRECTORY;
  experimental: boolean;
};

type Difference = {
  kind: "added" | "changed" | "removed";
  relativePath: string;
};

type RunOptions = {
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
};

export async function runCodexTypes(
  arguments_: string[],
  options: RunOptions = {},
): Promise<void> {
  const write = parseArguments(arguments_);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const environment = options.environment ?? process.env;
  const log = options.log ?? console.log;
  const manifest = await readCodexProtocolManifest(repositoryRoot);
  const codexBinary = environment.CODEX_BIN?.trim() || "codex";

  await assertCodexCliVersion(codexBinary, manifest.codexCliVersion, {
    cwd: repositoryRoot,
    environment,
  });

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "codex-remote-protocol-"));
  const generatedDirectory = path.join(temporaryRoot, "generated");
  const isolatedCodexHome = path.join(temporaryRoot, "codex-home");
  try {
    await mkdir(isolatedCodexHome, { recursive: true });
    const generatorArguments = [
      "app-server",
      "generate-ts",
      "--out",
      generatedDirectory,
    ];
    if (manifest.experimental) generatorArguments.push("--experimental");
    await runCommand(codexBinary, generatorArguments, {
      cwd: repositoryRoot,
      environment: {
        ...environment,
        CODEX_HOME: isolatedCodexHome,
        NO_COLOR: "1",
      },
    });

    const outputDirectory = path.join(repositoryRoot, manifest.outputDirectory);
    const differences = await compareDirectories(outputDirectory, generatedDirectory);
    if (!write) {
      if (differences.length > 0) {
        throw new Error(formatDifferenceFailure(manifest.outputDirectory, differences));
      }
      log(
        `Codex CLI ${manifest.codexCliVersion} 的生成结果与 ${manifest.outputDirectory} 完全一致` +
          `${manifest.experimental ? "（包含 experimental surface）" : ""}。`,
      );
      return;
    }

    await assertGeneratedTreeClean(repositoryRoot, manifest.outputDirectory);
    await replaceGeneratedDirectory(outputDirectory, generatedDirectory);
    log(
      differences.length === 0
        ? `${manifest.outputDirectory} 已经是 Codex CLI ${manifest.codexCliVersion} 的生成结果。`
        : `已用 Codex CLI ${manifest.codexCliVersion} 更新 ${manifest.outputDirectory}；` +
          `请审查 ${differences.length} 项生成差异。`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function readCodexProtocolManifest(
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): Promise<CodexProtocolManifest> {
  const source = await readFile(path.join(repositoryRoot, MANIFEST_NAME), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${MANIFEST_NAME} 不是有效 JSON。`, { cause: error });
  }
  if (!isObject(value)) {
    throw new Error(`${MANIFEST_NAME} 必须是对象。`);
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["codexCliVersion", "experimental", "outputDirectory"];
  if (keys.join("\n") !== expectedKeys.join("\n")) {
    throw new Error(`${MANIFEST_NAME} 只能包含 ${expectedKeys.join("、")}。`);
  }
  if (
    typeof value.codexCliVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.codexCliVersion)
  ) {
    throw new Error(`${MANIFEST_NAME} 的 codexCliVersion 必须是明确版本号。`);
  }
  if (value.outputDirectory !== EXPECTED_OUTPUT_DIRECTORY) {
    throw new Error(
      `${MANIFEST_NAME} 的 outputDirectory 必须是 ${EXPECTED_OUTPUT_DIRECTORY}，` +
        "确保更新的正是业务 import 的类型。",
    );
  }
  if (typeof value.experimental !== "boolean") {
    throw new Error(`${MANIFEST_NAME} 的 experimental 必须是布尔值。`);
  }
  return {
    codexCliVersion: value.codexCliVersion,
    outputDirectory: value.outputDirectory,
    experimental: value.experimental,
  };
}

export async function assertCodexCliVersion(
  codexBinary: string,
  expectedVersion: string,
  options: { cwd?: string; environment?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const { stdout } = await runCommand(codexBinary, ["--version"], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    environment: options.environment ?? process.env,
  });
  const actual = stdout.trim();
  const expected = `codex-cli ${expectedVersion}`;
  if (actual !== expected) {
    throw new Error(
      `当前 Codex CLI 是 ${JSON.stringify(actual || "（无版本输出）")}，` +
        `不等于 ${MANIFEST_NAME} 绑定的 ${JSON.stringify(expected)}。`,
    );
  }
}

function parseArguments(arguments_: string[]): boolean {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === "--check")) {
    return false;
  }
  if (arguments_.length === 1 && arguments_[0] === "--write") return true;
  throw new Error("用法：npm run codex:types [-- --check|--write]");
}

async function compareDirectories(currentRoot: string, generatedRoot: string): Promise<Difference[]> {
  const [current, generated] = await Promise.all([
    readDirectoryTree(currentRoot),
    readDirectoryTree(generatedRoot),
  ]);
  const paths = [...new Set([...current.keys(), ...generated.keys()])].sort();
  const differences: Difference[] = [];
  for (const relativePath of paths) {
    const currentContent = current.get(relativePath);
    const generatedContent = generated.get(relativePath);
    if (currentContent === undefined) {
      differences.push({ kind: "added", relativePath });
    } else if (generatedContent === undefined) {
      differences.push({ kind: "removed", relativePath });
    } else if (!currentContent.equals(generatedContent)) {
      differences.push({ kind: "changed", relativePath });
    }
  }
  return differences;
}

async function readDirectoryTree(root: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  await visit("");
  if (result.size === 0) throw new Error(`${root} 没有生成任何文件。`);
  return result;

  async function visit(relativeDirectory: string): Promise<void> {
    const directory = path.join(root, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(relativePath);
      } else if (entry.isFile()) {
        result.set(relativePath.split(path.sep).join("/"), await readFile(path.join(root, relativePath)));
      } else {
        throw new Error(`生成目录包含不支持的文件类型：${relativePath}`);
      }
    }
  }
}

function formatDifferenceFailure(outputDirectory: string, differences: Difference[]): string {
  const markers = { added: "A", changed: "M", removed: "D" } as const;
  const shown = differences
    .slice(0, 40)
    .map((difference) => `  ${markers[difference.kind]} ${difference.relativePath}`);
  if (differences.length > shown.length) {
    shown.push(`  …另有 ${differences.length - shown.length} 项`);
  }
  return [
    `隔离生成结果与 ${outputDirectory} 不一致（${differences.length} 项）：`,
    ...shown,
    "确认 CLI 版本和 manifest 后，用 --write 更新，再审查 git diff。",
  ].join("\n");
}

async function assertGeneratedTreeClean(
  repositoryRoot: string,
  outputDirectory: string,
): Promise<void> {
  const { stdout } = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", outputDirectory],
    { cwd: repositoryRoot, environment: process.env },
  );
  if (stdout.trim()) {
    throw new Error(`${outputDirectory} 有未提交改动；--write 不会覆盖它们。`);
  }
}

async function replaceGeneratedDirectory(currentRoot: string, generatedRoot: string): Promise<void> {
  const parent = path.dirname(currentRoot);
  const stagingRoot = await mkdtemp(path.join(parent, ".codex-types-"));
  const stagedGenerated = path.join(stagingRoot, "generated");
  const previousGenerated = path.join(stagingRoot, "previous");
  let previousMoved = false;
  let replacementMoved = false;
  try {
    await cp(generatedRoot, stagedGenerated, { recursive: true, force: false });
    await rename(currentRoot, previousGenerated);
    previousMoved = true;
    try {
      await rename(stagedGenerated, currentRoot);
      replacementMoved = true;
    } catch (error) {
      await rename(previousGenerated, currentRoot);
      previousMoved = false;
      throw error;
    }
  } finally {
    if (previousMoved && !replacementMoved) {
      await rename(previousGenerated, currentRoot).catch(() => undefined);
    }
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function runCommand(
  command: string,
  arguments_: string[],
  options: { cwd?: string; environment: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = commandFailureDetail(error);
    throw new Error(`命令失败：${command} ${arguments_.join(" ")}${detail}`, { cause: error });
  }
}

function commandFailureDetail(error: unknown): string {
  if (!isObject(error)) return "";
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const detail = stderr || stdout;
  return detail ? `\n${detail}` : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  runCodexTypes(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
