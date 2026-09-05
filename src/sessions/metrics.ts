import type { JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { Turn } from "../generated/v2/Turn.ts";

export type SessionMetrics = {
  context: { usedTokens: number; maxTokens: number; percentage: number } | null;
  windows: { label: string; remainingPercent: number | null; resetsAt: number | null }[];
  lastReplyAt: number | null;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 保存 Worker 退出后仍需展示的统计；不读取会话文件，也不为刷新启动 writer。 */
export class SessionMetricsStore {
  readonly #sessions = new Map<string, Pick<SessionMetrics, "context" | "lastReplyAt">>();
  #quota: SessionMetrics["windows"] = [];
  #pending: Promise<void> | null = null;

  seed(threadId: string, turns: Turn[]): void {
    const state = this.#state(threadId);
    for (const turn of turns) {
      if (turn.items.some(item => item.type === "agentMessage") &&
          typeof turn.completedAt === "number") {
        state.lastReplyAt = Math.max(state.lastReplyAt ?? 0, turn.completedAt);
      }
    }
  }

  observe(message: JsonObject): void {
    const params = object(message.params);
    if (typeof params?.threadId !== "string") return;
    const state = this.#state(params.threadId);
    if (message.method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const used = number(object(usage?.last)?.totalTokens);
      const max = number(usage?.modelContextWindow);
      state.context = used !== null && used >= 0 && max !== null && max > 0
        ? { usedTokens: used, maxTokens: max, percentage: used / max * 100 } : null;
    }
    if (message.method === "turn/completed") {
      const turn = object(params.turn);
      const items = Array.isArray(turn?.items) ? turn.items : [];
      if (items.some(item => object(item)?.type === "agentMessage")) {
        state.lastReplyAt = number(turn?.completedAt) ?? Math.floor(Date.now() / 1000);
      }
    }
    if (message.method === "item/completed" && object(params.item)?.type === "agentMessage") {
      state.lastReplyAt = Math.floor(Date.now() / 1000);
    }
  }

  async read(threadId: string, transport: AppServerTransport): Promise<SessionMetrics> {
    // 每个活动触发一次新查询；多个客户端同时查询时合并在途请求。
    this.#pending ??= this.#refreshQuota(transport).finally(() => { this.#pending = null; });
    await this.#pending;
    return { ...this.#state(threadId), windows: this.#quota };
  }

  #state(threadId: string) {
    let state = this.#sessions.get(threadId);
    if (!state) {
      state = { context: null, lastReplyAt: null };
      this.#sessions.set(threadId, state);
    }
    return state;
  }

  async #refreshQuota(transport: AppServerTransport): Promise<void> {
    try {
      const response = object(await transport.request("account/rateLimits/read", undefined));
      const byId = object(response?.rateLimitsByLimitId);
      const snapshots = byId && Object.keys(byId).length
        ? Object.values(byId) : [response?.rateLimits];
      this.#quota = snapshots.flatMap(value => {
        const snapshot = object(value);
        if (!snapshot) return [];
        const name = typeof snapshot.limitName === "string" ? snapshot.limitName
          : typeof snapshot.limitId === "string" ? snapshot.limitId : "Codex";
        return [snapshot.primary, snapshot.secondary].flatMap(value => {
          const window = object(value);
          if (!window) return [];
          const minutes = number(window.windowDurationMins);
          const duration = minutes === null ? "" : minutes % 1440 === 0
            ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
          const used = number(window.usedPercent);
          return [{ label: `${name}${duration ? `（${duration}）` : ""}`,
            remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
            resetsAt: number(window.resetsAt) }];
        });
      });
    } catch {
      // 查询失败不把上次的额度冒充为当前值；上下文与最后回复仍然可用。
      this.#quota = [];
    }
  }
}
