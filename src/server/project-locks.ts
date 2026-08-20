export type ProjectTaskLease = {
  projectId: string;
  ownerId: string;
  sessionId: string;
  taskId: string | null;
};

/** 后端进程内的项目级任务锁：一个项目同一时刻只能有一个 AI 任务。 */
export class ProjectTaskLocks {
  readonly #leases = new Map<string, ProjectTaskLease>();

  acquire(projectId: string, ownerId: string, sessionId: string): boolean {
    if (this.#leases.has(projectId)) {
      return false;
    }
    this.#leases.set(projectId, {
      projectId,
      ownerId,
      sessionId,
      taskId: null,
    });
    return true;
  }

  setTaskId(projectId: string, ownerId: string, taskId: string): boolean {
    const lease = this.#leases.get(projectId);
    if (!lease || lease.ownerId !== ownerId) {
      return false;
    }
    lease.taskId = taskId;
    return true;
  }

  owns(projectId: string, ownerId: string): boolean {
    return this.#leases.get(projectId)?.ownerId === ownerId;
  }

  release(projectId: string, ownerId: string): boolean {
    if (!this.owns(projectId, ownerId)) {
      return false;
    }
    this.#leases.delete(projectId);
    return true;
  }
}
