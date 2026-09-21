import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const connectSource = source.slice(
  source.indexOf("async function connect("),
  source.indexOf("function handleSocketMessage("),
);

function harness(fetch, search = "") {
  const sockets = [];
  const actions = [];
  const clearedNotices = [];
  const context = vm.createContext({
    fetch,
    RECONNECT_DELAY_MS: 1200,
    CONNECTION_NOTICE_KEY: "connection",
    URL,
    URLSearchParams,
    location: {
      protocol: "https:",
      host: "example.com",
      origin: "https://example.com",
      search,
      replace: (href) => actions.push(["redirect", href]),
    },
    state: {
      generation: 0,
      reconnectTimer: null,
      reconnectAllowed: true,
      authenticated: false,
      backgroundWorkers: false,
      socket: null,
    },
    elements: {
      tokenInput: { value: "credential" },
      loginStatus: { textContent: "" },
      connectButton: { disabled: false },
      appView: { hidden: true },
      approvalList: { replaceChildren() {} },
    },
    clearTimeout() {},
    setTimeout: () => 1,
    rejectPending() {},
    showLogin: () => actions.push(["login"]),
    showApp: () => actions.push(["app"]),
    setConnectionStatus() {},
    errorMessage: (error) => error.message,
    slashCommands: { load: async () => {}, close() {} },
    loadProjects: async () => actions.push(["projects"]),
    flushQueuedAttachments: async () => {},
    retryOutboxForCurrentSession: async () => {},
    handleSocketMessage() {},
    renderSessionMetrics() {},
    hideThinking() {},
    updateControls() {},
    showNotice() {},
    clearNotice: (key) => clearedNotices.push(key),
    WebSocket: class {
      listeners = {};
      readyState = 1;
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      addEventListener(name, listener) { this.listeners[name] = listener; }
      close() {}
    },
  });
  vm.runInContext(connectSource, context);
  return { context, sockets, actions, clearedNotices };
}

test("cookie login opens WebSocket without an auth frame and preserves feature negotiation", async () => {
  const requests = [];
  const { context, sockets, actions, clearedNotices } = harness(async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ features: { backgroundWorkers: true } }));
  });
  await context.connect("test-credential");
  assert.equal(requests[0].url, "/auth/login");
  assert.equal(JSON.parse(requests[0].options.body).token, "test-credential");
  assert.equal(context.elements.tokenInput.value, "");
  assert.equal(context.state.backgroundWorkers, true);
  assert.equal(sockets.length, 1);
  await sockets[0].listeners.open();
  assert.equal(context.state.authenticated, true);
  assert.deepEqual(actions, [["app"], ["projects"]]);
  assert.deepEqual(clearedNotices, ["connection"]);
});

test("missing cookies prompt login and do not enter a reconnect loop", async () => {
  const { context, sockets, actions } = harness(async () => new Response(null, { status: 401 }));
  await context.connect();
  assert.equal(sockets.length, 0);
  assert.equal(context.state.reconnectAllowed, false);
  assert.deepEqual(actions, [["login"]]);
});

test("network failures report that the server did not respond", async () => {
  const { context, sockets } = harness(async () => {
    throw new TypeError("Failed to fetch");
  });
  await context.connect("test-credential");
  assert.equal(sockets.length, 0);
  assert.equal(
    context.elements.loginStatus.textContent,
    "没有收到服务器响应。请求可能未到达服务器，或者连接在服务器响应前中断。请检查网络或代理设置后重试。",
  );
});

test("successful login returns only to a same-origin viewer", async () => {
  for (const target of [
    "/view?path=%2Fprojects%2Fdemo%2Fnote.md",
    "https://attacker.example/view?path=note.md",
    "//attacker.example/view?path=note.md",
  ]) {
    const { context, actions } = harness(
      async () => new Response("{}"),
      `?${new URLSearchParams({ returnTo: target })}`,
    );
    await context.connect();
    assert.equal(
      actions.some(([action]) => action === "redirect"),
      target.startsWith("/view?"),
    );
  }
});
