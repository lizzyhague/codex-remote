import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { StartupAbortedError, StartupDeadline, StopIntent } from "./lifecycle.ts";

function fakeSignals(): EventEmitter & { emit(signal: NodeJS.Signals): boolean } {
  return new EventEmitter();
}

test("stop intent is recorded synchronously inside the signal callback", () => {
  const signals = fakeSignals();
  const stop = new StopIntent(signals);
  assert.equal(stop.stopRequested, false);
  signals.emit("SIGTERM");
  // 同一调用栈内即可见，不依赖任何微任务。
  assert.equal(stop.stopRequested, true);
  stop.dispose();
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("a stop signal arriving shortly after a failure is still seen", async () => {
  const signals = fakeSignals();
  const stop = new StopIntent(signals);
  setTimeout(() => signals.emit("SIGINT"), 10);
  assert.equal(await stop.arrivesWithin(1_000), true);
  stop.dispose();
});

test("without a stop signal the grace window ends as a failure", async () => {
  const stop = new StopIntent(fakeSignals());
  const started = Date.now();
  assert.equal(await stop.arrivesWithin(30), false);
  assert.ok(Date.now() - started >= 25);
  stop.dispose();
});

test("startup deadline rejects work that never settles", async () => {
  const stop = new StopIntent(fakeSignals());
  const startup = new StartupDeadline(stop, 20);
  await assert.rejects(
    startup.guard(new Promise(() => {})),
    (error: unknown) => error instanceof StartupAbortedError && error.reason === "timeout",
  );
  assert.throws(() => startup.check(), StartupAbortedError);
  stop.dispose();
});

test("a stop signal during startup cancels pending startup work", async () => {
  const signals = fakeSignals();
  const stop = new StopIntent(signals);
  const startup = new StartupDeadline(stop, 60_000);
  const pending = startup.guard(new Promise(() => {}));
  signals.emit("SIGTERM");
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof StartupAbortedError && error.reason === "stop",
  );
  stop.dispose();
});

test("a finished startup is no longer cancelled by its deadline or by stop", async () => {
  const signals = fakeSignals();
  const stop = new StopIntent(signals);
  const startup = new StartupDeadline(stop, 20);
  assert.equal(await startup.guard(Promise.resolve("ready")), "ready");
  startup.finish();
  await delay(40);
  signals.emit("SIGTERM");
  await delay(0);
  assert.equal(startup.aborted, false);
  assert.doesNotThrow(() => startup.check());
  stop.dispose();
});
