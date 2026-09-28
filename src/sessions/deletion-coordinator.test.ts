import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AppServerRpcError } from "../app-server/client.ts";
import { injectFsFaults } from "../workers/fs-fault-injection.ts";
import {
  type DeletedSessionArtifacts,
  SessionDeletionCoordinator,
  type ThreadDeleteRequester,
} from "./deletion-coordinator.ts";
import { MarkStore } from "./mark-store.ts";
import { TrashStore, type TrashEntry } from "./trash-store.ts";

async function fixture(context: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-deletion-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const trash = await TrashStore.open(path.join(directory, "trash.json"));
  const marks = await MarkStore.open(path.join(directory, "marks.json"));
  const entry: TrashEntry = {
    threadId: "thread-1",
    projectId: "projects/demo",
    deletedAt: 100,
    origin: "active",
    state: "trashed",
  };
  await trash.put(entry);
  await marks.put({ threadId: entry.threadId, projectId: entry.projectId });
  return { trash, marks, entry };
}

test("persists deletion intent before deleting and waits for every local cleanup", async (context) => {
  const { trash, marks, entry } = await fixture(context);
  const order: string[] = [];
  const transport: ThreadDeleteRequester = {
    async request<Result>() {
      assert.equal(trash.get(entry.threadId)?.state, "deleting");
      order.push("codex");
      return {} as Result;
    },
  };
  const artifacts: DeletedSessionArtifacts = {
    async forgetSession(threadId) {
      assert.equal(threadId, entry.threadId);
      assert.equal(marks.has(threadId), true);
      order.push("artifacts");
    },
  };
  const coordinator = new SessionDeletionCoordinator(transport, trash, { marks, artifacts });

  await coordinator.delete(entry);

  assert.deepEqual(order, ["codex", "artifacts"]);
  assert.equal(trash.has(entry.threadId), false);
  assert.equal(marks.has(entry.threadId), false);
});

test("keeps deletion pending after a failure and safely resumes an already deleted thread", async (context) => {
  const { trash, marks, entry } = await fixture(context);
  const responses: Array<Error | object> = [
    new Error("connection lost after delete"),
    new AppServerRpcError({
      code: -32600,
      message: `no rollout found for thread id ${entry.threadId}`,
    }),
  ];
  let requests = 0;
  let cleanups = 0;
  const transport: ThreadDeleteRequester = {
    async request<Result>() {
      requests += 1;
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response as Result;
    },
  };
  const artifacts: DeletedSessionArtifacts = {
    async forgetSession() {
      cleanups += 1;
    },
  };
  const coordinator = new SessionDeletionCoordinator(transport, trash, { marks, artifacts });

  await assert.rejects(coordinator.delete(entry), /connection lost/u);
  const pending = trash.get(entry.threadId);
  assert.equal(pending?.state, "deleting");
  assert.equal(marks.has(entry.threadId), true);
  assert.equal(cleanups, 0);

  await coordinator.delete(pending!);
  assert.equal(requests, 2);
  assert.equal(cleanups, 1);
  assert.equal(trash.has(entry.threadId), false);
  assert.equal(marks.has(entry.threadId), false);
});

test("retries idempotent local cleanup before removing the durable deletion record", async (context) => {
  const { trash, marks, entry } = await fixture(context);
  let requests = 0;
  const transport: ThreadDeleteRequester = {
    async request<Result>() {
      requests += 1;
      if (requests === 1) return {} as Result;
      throw new AppServerRpcError({
        code: -32600,
        message: `no rollout found for thread id ${entry.threadId}`,
      });
    },
  };
  let cleanups = 0;
  const artifacts: DeletedSessionArtifacts = {
    async forgetSession() {
      cleanups += 1;
      if (cleanups === 1) throw new Error("attachment index is busy");
    },
  };
  const coordinator = new SessionDeletionCoordinator(transport, trash, { marks, artifacts });

  await assert.rejects(coordinator.delete(entry), /attachment index is busy/u);
  const pending = trash.get(entry.threadId);
  assert.equal(pending?.state, "deleting");
  assert.equal(marks.has(entry.threadId), true);

  await coordinator.delete(pending!);
  assert.equal(requests, 2);
  assert.equal(cleanups, 2);
  assert.equal(trash.has(entry.threadId), false);
  assert.equal(marks.has(entry.threadId), false);
});

test("does not delete the Codex thread until the deleting record is durable", async (context) => {
  const { trash, marks, entry } = await fixture(context);
  let requests = 0;
  const transport: ThreadDeleteRequester = {
    async request<Result>() {
      requests += 1;
      return {} as Result;
    },
  };
  const coordinator = new SessionDeletionCoordinator(transport, trash, { marks });
  const faults = injectFsFaults(context, { fail: { "directory-sync": 1 } });

  await assert.rejects(coordinator.delete(entry), /injected directory-sync failure/u);
  assert.equal(requests, 0);
  assert.equal(trash.get(entry.threadId)?.state, "trashed");
  assert.equal(marks.has(entry.threadId), true);

  faults.heal();
  await coordinator.delete(trash.get(entry.threadId)!);
  assert.equal(requests, 1);
  assert.equal(trash.has(entry.threadId), false);
  assert.equal(marks.has(entry.threadId), false);
});
