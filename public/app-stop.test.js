import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { localize, t } from "./i18n.test-support.js";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

function taskButton(label = "停止") {
  return {
    disabled: false,
    dataset: { action: label === "发送" ? "send" : "stop" },
    title: label,
    ariaLabel: label,
    classList: { toggle() {} },
    setAttribute(name, value) {
      if (name === "aria-label") this.ariaLabel = value;
    },
  };
}

test("requested true keeps the stopping state until the task completes", async () => {
  const notices = [];
  const resumes = [];
  const requests = [];
  const button = taskButton();
  const context = vm.createContext({
    t,
    localize,
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      projectId: "project-1",
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
    },
    TEMPORARY_WARNING: { lifetime: "temporary", tone: "warning" },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: { taskButton: button },
    request: async (type, payload) => {
      requests.push({ type, payload });
      return { requested: true };
    },
    resumeSession: async (sessionId) => {
      resumes.push({ sessionId });
    },
    showNotice: (message) => notices.push(message),
    updateControls() {
      if (context.state.stopping) {
        button.dataset.action = "stop";
        button.setAttribute("aria-label", "停止中");
        button.title = "停止中";
        button.disabled = true;
      } else {
        const label = context.state.running ? "停止" : "发送";
        button.dataset.action = context.state.running ? "stop" : "send";
        button.setAttribute("aria-label", label);
        button.title = label;
        button.disabled = false;
      }
    },
    errorMessage: (error) => error.message,
  });
  vm.runInContext(section("async function stopTask()", "function handleServerEvent("), context);
  await context.stopTask();
  assert.equal(context.state.stopping, true);
  assert.equal(context.state.running, true);
  assert.equal(button.dataset.action, "stop");
  assert.equal(button.ariaLabel, "停止中");
  assert.equal(button.title, "停止中");
  assert.equal(notices.length, 0);
  assert.equal(resumes.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    type: "task.stop",
    payload: { projectId: "project-1", sessionId: "session-1" },
  }]);
});

test("requested false resyncs the session and does not clear running itself", async () => {
  const notices = [];
  const resumes = [];
  const context = vm.createContext({
    t,
    localize,
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      projectId: "project-1",
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
    },
    TEMPORARY_WARNING: { lifetime: "temporary", tone: "warning" },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: { taskButton: taskButton() },
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
  assert.equal(notices[0], "任务已经结束或状态已变化");
});

test("a failed stop request restores the button and keeps the task running", async () => {
  const notices = [];
  const context = vm.createContext({
    t,
    localize,
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      projectId: "project-1",
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
    },
    TEMPORARY_WARNING: { lifetime: "temporary", tone: "warning" },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: { taskButton: taskButton() },
    request: async () => {
      throw Object.assign(new Error("停止失败"), { code: "request_failed" });
    },
    resumeSession: async () => {
      throw new Error("不应重开会话");
    },
    showNotice: (message) => notices.push(message),
    updateControls() {
      const label = context.state.stopping
        ? "停止中"
        : (context.state.running ? "停止" : "发送");
      context.elements.taskButton.dataset.action = context.state.running ? "stop" : "send";
      context.elements.taskButton.setAttribute("aria-label", label);
      context.elements.taskButton.title = label;
      context.elements.taskButton.disabled = Boolean(context.state.stopping);
    },
    errorMessage: (error) => error.message,
  });
  vm.runInContext(section("async function stopTask()", "function handleServerEvent("), context);
  await context.stopTask();
  assert.equal(context.state.stopping, false);
  assert.equal(context.state.running, true);
  assert.equal(context.elements.taskButton.dataset.action, "stop");
  assert.equal(context.elements.taskButton.ariaLabel, "停止");
  assert.equal(context.elements.taskButton.title, "停止");
  assert.equal(notices[0], "停止失败");
});

test("a compaction past its instruction is refused without resyncing the session", async () => {
  const notices = [];
  const resumes = [];
  const context = vm.createContext({
    t,
    localize,
    state: {
      running: true,
      stopping: false,
      controlsTask: true,
      projectId: "project-1",
      sessionId: "session-1",
      authenticated: true,
      connectionReady: true,
    },
    TEMPORARY_WARNING: { lifetime: "temporary", tone: "warning" },
    TEMPORARY_ERROR: { lifetime: "temporary", tone: "error" },
    elements: { taskButton: taskButton() },
    request: async () => ({ requested: false, reason: "compact_started" }),
    resumeSession: async (sessionId) => {
      resumes.push(sessionId);
    },
    showNotice: (message) => notices.push(message),
    updateControls() {},
    errorMessage: (error) => error.message,
  });
  vm.runInContext(section("async function stopTask()", "function handleServerEvent("), context);
  await context.stopTask();
  assert.equal(context.state.stopping, false);
  assert.equal(context.state.running, true);
  assert.deepEqual(resumes, []);
  assert.equal(notices[0], "压缩已经开始，不能中途停止");
});
