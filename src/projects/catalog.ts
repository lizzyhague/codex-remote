import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isObject } from "../shared/json.ts";
import { PublicError } from "../shared/public-error.ts";
import { localText, type LocalText } from "../shared/local-text.ts";

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

class ProjectCatalogError extends PublicError {
  constructor(text: LocalText) {
    super(text);
    this.name = "ProjectCatalogError";
  }
}

/** Cache lifetime for directory scans: imperceptible to users but long enough to avoid repeats within one operation. */
const SCAN_CACHE_TTL_MS = 1_000;

/**
 * Scans allowed project roots. The browser sees only project IDs and names and cannot supply arbitrary paths.
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
      throw new Error(`The project roots config is not valid JSON: ${configPath}`);
    }

    if (!isProjectConfigFile(parsed)) {
      throw new Error(`The project roots config has an invalid format: ${configPath}`);
    }

    return ProjectCatalog.fromRoots(parsed.roots);
  }

  static async fromRoots(roots: ProjectRootConfig[]): Promise<ProjectCatalog> {
    if (roots.length === 0) {
      throw new Error("Configure at least one project root.");
    }

    const seenIds = new Set<string>();
    const rootsByRealPath = new Map<string, string>();
    const resolvedRoots: ResolvedRoot[] = [];

    for (const root of roots) {
      if (!/^[a-z0-9][a-z0-9_-]*$/u.test(root.id)) {
        throw new Error(`Invalid project root ID: ${root.id}`);
      }
      if (seenIds.has(root.id)) {
        throw new Error(`Duplicate project root ID: ${root.id}`);
      }
      if (!path.isAbsolute(root.path)) {
        throw new Error(`A project root must be an absolute path: ${root.path}`);
      }

      const rootRealPath = await realpath(root.path);
      const rootStats = await stat(rootRealPath);
      if (!rootStats.isDirectory()) {
        throw new Error(`A project root is not a directory: ${root.path}`);
      }
      const conflictingRootId = rootsByRealPath.get(rootRealPath);
      if (conflictingRootId) {
        throw new Error(`Project roots point to the same location: ${conflictingRootId} and ${root.id}`);
      }

      seenIds.add(root.id);
      rootsByRealPath.set(rootRealPath, root.id);
      resolvedRoots.push({ ...root, realPath: rootRealPath });
    }

    return new ProjectCatalog(resolvedRoots);
  }

  async list(): Promise<ProjectSummary[]> {
    const projects = await this.#scan();
    return projects.map(({ path: _path, ...summary }) => summary);
  }

  /** Used only as an in-process file access boundary; must never be sent to the browser. */
  rootPaths(): string[] {
    return this.#roots.map((root) => root.realPath);
  }

  /**
   * Rescans and resolves the ID before each operation instead of accepting a file path from the browser.
   */
  async resolve(projectId: string): Promise<ResolvedProject> {
    const projects = await this.#scan();
    const project = projects.find((candidate) => candidate.id === projectId);

    if (!project) {
      throw new ProjectCatalogError(localText("error.projectNotFound"));
    }

    return project;
  }

  async #scan(): Promise<ResolvedProject[]> {
    // Opening a session resolves the project ID several times in succession, so repeating readdir + realpath + stat
    // each time is unnecessary. The cache is very short-lived: one refresh reveals newly created project folders,
    // while cached entries contain real paths resolved during the scan and do not weaken the allowlist boundary.
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
    const projectsByRealPath = new Map<string, string>();

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

        const projectId = `${root.id}/${encodeURIComponent(entry.name)}`;
        const conflictingProjectId = projectsByRealPath.get(candidateRealPath);
        if (conflictingProjectId) {
          throw new Error(`Duplicate project directory identity: ${conflictingProjectId} and ${projectId}`);
        }
        projectsByRealPath.set(candidateRealPath, projectId);
        projects.push({
          id: projectId,
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
