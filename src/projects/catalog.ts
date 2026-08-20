import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type ProjectRootConfig = {
  id: string;
  path: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  rootId: string;
};

type ResolvedProject = ProjectSummary & {
  path: string;
};

type ProjectConfigFile = {
  roots: ProjectRootConfig[];
};

type ResolvedRoot = ProjectRootConfig & {
  realPath: string;
};

/** 目录扫描结果的缓存时长。短到用户察觉不到，长到能挡住一次操作里的重复扫描。 */
const SCAN_CACHE_TTL_MS = 1_000;

/**
 * 扫描允许的项目根目录。浏览器只会看到项目 ID 和名称，不会提供任意路径。
 */
export class ProjectCatalog {
  readonly #roots: ResolvedRoot[];
  #cache: { expiresAt: number; projects: ResolvedProject[] } | null = null;

  private constructor(roots: ResolvedRoot[]) {
    this.#roots = roots;
  }

  static async fromConfigFile(configPath: string): Promise<ProjectCatalog> {
    const source = await readFile(configPath, "utf8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`项目根目录配置不是有效 JSON：${configPath}`);
    }

    if (!isProjectConfigFile(parsed)) {
      throw new Error(`项目根目录配置格式不正确：${configPath}`);
    }

    return ProjectCatalog.fromRoots(parsed.roots);
  }

  static async fromRoots(roots: ProjectRootConfig[]): Promise<ProjectCatalog> {
    if (roots.length === 0) {
      throw new Error("至少需要配置一个项目根目录。");
    }

    const seenIds = new Set<string>();
    const resolvedRoots: ResolvedRoot[] = [];

    for (const root of roots) {
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(root.id)) {
        throw new Error(`项目根目录 ID 不合法：${root.id}`);
      }
      if (seenIds.has(root.id)) {
        throw new Error(`项目根目录 ID 重复：${root.id}`);
      }
      if (!path.isAbsolute(root.path)) {
        throw new Error(`项目根目录必须使用绝对路径：${root.path}`);
      }

      const rootRealPath = await realpath(root.path);
      const rootStats = await stat(rootRealPath);
      if (!rootStats.isDirectory()) {
        throw new Error(`项目根目录不是文件夹：${root.path}`);
      }

      seenIds.add(root.id);
      resolvedRoots.push({ ...root, realPath: rootRealPath });
    }

    return new ProjectCatalog(resolvedRoots);
  }

  async list(): Promise<ProjectSummary[]> {
    const projects = await this.#scan();
    return projects.map(({ path: _path, ...summary }) => summary);
  }

  /**
   * 每次开始工作前重新扫描并解析 ID，不直接接受浏览器传来的文件路径。
   */
  async resolve(projectId: string): Promise<ResolvedProject> {
    const projects = await this.#scan();
    const project = projects.find((candidate) => candidate.id === projectId);

    if (!project) {
      throw new Error("项目不存在，或不在允许的根目录中。");
    }

    return project;
  }

  async #scan(): Promise<ResolvedProject[]> {
    // 打开一个会话会连续多次解析项目 ID，每次都重新 readdir + realpath + stat
    // 是没必要的。缓存只保留很短时间：新建的项目文件夹刷新一次就能看到，
    // 而缓存里存的是扫描当时已经解析好的真实路径，不会放宽白名单边界。
    const cached = this.#cache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.projects;
    }
    const projects = await this.#scanRoots();
    this.#cache = { expiresAt: Date.now() + SCAN_CACHE_TTL_MS, projects };
    return projects;
  }

  async #scanRoots(): Promise<ResolvedProject[]> {
    const projects: ResolvedProject[] = [];

    for (const root of this.#roots) {
      const entries = await readdir(root.realPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith(".") || !entry.isDirectory()) {
          continue;
        }

        const candidatePath = path.join(root.realPath, entry.name);
        const candidateRealPath = await realpath(candidatePath);
        if (!isStrictChild(root.realPath, candidateRealPath)) {
          continue;
        }

        const candidateStats = await stat(candidateRealPath);
        if (!candidateStats.isDirectory()) {
          continue;
        }

        projects.push({
          id: `${root.id}/${encodeURIComponent(entry.name)}`,
          name: entry.name,
          rootId: root.id,
          path: candidateRealPath,
        });
      }
    }

    return projects.sort((left, right) =>
      left.name.localeCompare(right.name) || left.rootId.localeCompare(right.rootId)
    );
  }
}

function isStrictChild(rootPath: string, candidatePath: string): boolean {
  const relation = path.relative(rootPath, candidatePath);
  return relation !== "" && !relation.startsWith("..") && !path.isAbsolute(relation);
}

function isProjectConfigFile(value: unknown): value is ProjectConfigFile {
  return isObject(value) &&
    Array.isArray(value.roots) &&
    value.roots.every((root) =>
      isObject(root) &&
      typeof root.id === "string" &&
      typeof root.path === "string"
    );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
