import { localText, type DisplayText } from "../shared/local-text.ts";
import type { JsonObject } from "../app-server/client.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";
import type { Turn } from "../generated/v2/Turn.ts";

export type SessionMetrics = {
  context: { usedTokens: number; maxTokens: number; percentage: number } | null;
  windows: { label: DisplayText; remainingPercent: number | null; resetsAt: number | null }[];
  lastReplyAt: number | null;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Retain statistics needed after a Worker exits; do not read session files or start a writer for refreshes. */
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
    // Each activity triggers a fresh query; concurrent client queries share the in-flight request.
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
          const duration = minutes === null ? null : minutes % 1440 === 0
            ? localText("metrics.days", { count: minutes / 1440 })
            : minutes % 60 === 0
            ? localText("metrics.hours", { count: minutes / 60 })
            : localText("metrics.minutes", { count: minutes });
          const used = number(window.usedPercent);
          // The plain Codex plan shows only its window, such as "5 hours"; other limits keep their name.
          const label = !duration ? name : name.toLowerCase() === "codex"
            ? duration : localText("metrics.namedWindow", { name, window: duration });
          return [{ label,
            remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
            resetsAt: number(window.resetsAt) }];
        });
      });
    } catch {
      // Do not present the previous quota as current after a failed query; context and the last reply remain usable.
      this.#quota = [];
    }
  }
}
