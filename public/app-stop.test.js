import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test("requested true keeps the stopping state until the task completes", async () => {
  const notices = [];
  const resumes = [];
  const button = { disabled: false, textContent: "停止", classList: { toggle() {} } };
  const context = vm.createContext({
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
      backgroundWorkers: false,
    },
    elements: { taskButton: button },
    request: async () => ({ requested: true }),
    resumeSession: async (sessionId, options) => {
      resumes.push({ sessionId, options });
    },
    showNotice: (message) => notices.push(message),
    updateControls() {
      if (context.state.stopping) {
        button.textContent = "停止中";
        button.disabled = true;
      } else {
        button.textContent = context.state.running ? "停止" : "发送";
        button.disabled = false;
      }
    },
    errorMessage: (error) => error.message,
  });
  vm.runInContext(section("async function stopTask()", "function handleServerEvent("), context);
  await context.stopTask();
  assert.equal(context.state.stopping, true);
  assert.equal(context.state.running, true);
  assert.equal(button.textContent, "停止中");
  assert.equal(notices.length, 0);
  assert.equal(resumes.length, 0);
});

test("requested false force-resyncs the session and does not clear running itself", async () => {
  const notices = [];
  const resumes = [];
  const context = vm.createContext({
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
      backgroundWorkers: false,
    },
    elements: { taskButton: { disabled: false, textContent: "停止", classList: { toggle() {} } } },
    request: async () => ({ requested: false }),
    resumeSession: async (sessionId, options) => {
      resumes.push({ sessionId, options });
    },
    showNotice: (message) => notices.push(message),
    updateControls() {},
    errorMessage: (error) => error.message,
  });
  vm.runInContext(section("async function stopTask()", "function handleServerEvent("), context);
  await context.stopTask();
  assert.equal(context.state.stopping, false);
  assert.equal(context.state.running, true);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].sessionId, "session-1");
  assert.equal(resumes[0].options.force, true);
  assert.equal(notices[0], "任务已经结束或状态已变化");
});

test("a failed stop request restores the button and keeps the task running", async () => {
  const notices = [];
  const context = vm.createContext({
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
      backgroundWorkers: false,
    },
    elements: { taskButton: { disabled: false, textContent: "停止", classList: { toggle() {} } } },
    request: async () => {
      throw Object.assign(new Error("停止失败"), { code: "request_failed" });
    },
    resumeSession: async () => {
      throw new Error("不应重开会话");
    },
    showNotice: (message) => notices.push(message),
    updateControls() {
      context.elements.taskButton.textContent = context.state.stopping
        ? "停止中"
        : (context.state.running ? "停止" : "发送");
      context.elements.taskButton.disabled = Boolean(context.state.stopping);
    },
    errorMessage: (error) => error.message,
  });
  vm.runInContext(section("async function stopTask()", "function handleServerEvent("), context);
  await context.stopTask();
  assert.equal(context.state.stopping, false);
  assert.equal(context.state.running, true);
  assert.equal(context.elements.taskButton.textContent, "停止");
  assert.equal(notices[0], "停止失败");
});
