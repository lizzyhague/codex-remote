import assert from "node:assert/strict";
import test from "node:test";

import { ProjectTaskLocks } from "./project-locks.ts";

test("allows only one active task per project", () => {
  const locks = new ProjectTaskLocks();
  assert.equal(locks.acquire("project-1", "phone", "session-1"), true);
  assert.equal(locks.acquire("project-1", "computer", "session-2"), false);
  assert.equal(locks.setTaskId("project-1", "phone", "task-1"), true);
  assert.equal(locks.release("project-1", "computer"), false);
  assert.equal(locks.release("project-1", "phone"), true);
  assert.equal(locks.acquire("project-1", "computer", "session-2"), true);
});
