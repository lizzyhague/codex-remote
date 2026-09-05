import assert from "node:assert/strict";
import test from "node:test";
import { SessionMetricsStore } from "./metrics.ts";
import type { AppServerTransport } from "../app-server/turn-session.ts";

function transport(response: unknown, fail = false) {
  let calls = 0;
  return {
    get calls() { return calls; },
    api: { async request() { calls++; if (fail) throw new Error("offline"); return response; } } as unknown as AppServerTransport,
  };
}

test("metrics isolates threads and uses latest call rather than cumulative tokens", async () => {
  const store = new SessionMetricsStore();
  const source = transport({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 } } });
  store.observe({ method: "thread/tokenUsage/updated", params: {
    threadId: "a", tokenUsage: { total: { totalTokens: 90000 }, last: { totalTokens: 2000 }, modelContextWindow: 10000 },
  } });
  const [a, b] = await Promise.all([store.read("a", source.api), store.read("b", source.api)]);
  assert.equal(a.context?.percentage, 20);
  assert.equal(b.context, null);
  assert.equal(a.windows[0]?.remainingPercent, 75);
  assert.equal(a.windows[0]?.resetsAt, 1800000000);
  assert.equal(a.windows[0]?.label, "Codex（5 小时）");
  assert.equal(source.calls, 1);
  await store.read("a", source.api);
  assert.equal(source.calls, 2);
});

test("quota failure preserves context and reply information without inventing zero usage", async () => {
  const store = new SessionMetricsStore();
  const source = transport(null, true);
  store.observe({ method: "turn/completed", params: { threadId: "a", turn: {
    completedAt: 1234, items: [{ type: "agentMessage" }],
  } } });
  const result = await store.read("a", source.api);
  assert.equal(result.lastReplyAt, 1234);
  assert.equal(result.context, null);
  assert.deepEqual(result.windows, []);
});

test("empty quota map falls back to primary snapshot and invalid context stays unavailable", async () => {
  const store = new SessionMetricsStore();
  store.observe({ method: "thread/tokenUsage/updated", params: { threadId: "a",
    tokenUsage: { last: { totalTokens: 3 }, modelContextWindow: 0 } } });
  const source = transport({ rateLimitsByLimitId: {}, rateLimits: { primary: { usedPercent: 110 } } });
  const result = await store.read("a", source.api);
  assert.equal(result.context, null);
  assert.equal(result.windows[0]?.remainingPercent, 0);
  assert.equal(result.windows[0]?.resetsAt, null);
});


test("a new activity refreshes quota immediately, including recovery after failure", async () => {
  const store = new SessionMetricsStore();
  const response = { rateLimits: { primary: { usedPercent: 25 } } };
  const source = transport(response);
  assert.equal((await store.read("a", source.api)).windows[0]?.remainingPercent, 75);
  response.rateLimits.primary.usedPercent = 40;
  assert.equal((await store.read("a", source.api)).windows[0]?.remainingPercent, 60);
  assert.deepEqual((await store.read("a", transport(null, true).api)).windows, []);
  assert.equal((await store.read("a", source.api)).windows[0]?.remainingPercent, 60);
});
