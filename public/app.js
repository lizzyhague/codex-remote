import { renderMarkdown } from "./markdown.js?v=12";

const TOKEN_KEY = "codex-remote.token";
const PROJECT_KEY = "codex-remote.project";
const SESSION_KEY = "codex-remote.session";
const SIDEBAR_COLLAPSED_KEY = "codex-remote.sidebar-collapsed";
const RECONNECT_DELAY_MS = 2_500;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT = 100_000;
/** 输入框失焦后稍等再点亮 rewind / full access，避免同一下既失焦又点到确认。 */
const COMPOSER_CONFIRM_UNLOCK_MS = 300;

const elements = {
  loginView: byId("login-view"),
  tokenForm: byId("token-form"),
  tokenInput: byId("token-input"),
  connectButton: byId("connect-button"),
  loginStatus: byId("login-status"),
  appView: byId("app-view"),
  connectionStatus: byId("connection-status"),
  changeTokenButton: byId("change-token-button"),
  currentSessionTitle: byId("current-session-title"),
  sessionSidebar: byId("session-sidebar"),
  openSidebarButton: byId("open-sidebar-button"),
  collapseSidebarButton: byId("collapse-sidebar-button"),
  sidebarBackdrop: byId("sidebar-backdrop"),
  projectSelect: byId("project-select"),
  newSessionButton: byId("new-session-button"),
  sessionSearchInput: byId("session-search-input"),
  sessionViewBackButton: byId("session-view-back-button"),
  sessionViewTitle: byId("session-view-title"),
  selectSessionsButton: byId("select-sessions-button"),
  selectionHeading: byId("selection-heading"),
  cancelSelectionButton: byId("cancel-selection-button"),
  selectionCount: byId("selection-count"),
  sessionList: byId("session-list"),
  loadMoreSessionsButton: byId("load-more-sessions-button"),
  sessionDestinations: byId("session-destinations"),
  archivedSessionsButton: byId("archived-sessions-button"),
  trashSessionsButton: byId("trash-sessions-button"),
  bulkSessionActions: byId("bulk-session-actions"),
  bulkPrimaryButton: byId("bulk-primary-button"),
  bulkTrashButton: byId("bulk-trash-button"),
  timeline: byId("timeline"),
  historyLoader: byId("history-loader"),
  loadOlderButton: byId("load-older-button"),
  emptyState: byId("empty-state"),
  thinkingIndicator: byId("thinking-indicator"),
  thinkingLabel: byId("thinking-label"),
  approvalList: byId("approval-list"),
  notice: byId("notice"),
  noticeText: byId("notice-text"),
  noticeActionButton: byId("notice-action-button"),
  composer: byId("composer"),
  slashMenu: slashMenuElement(),
  messageInput: byId("message-input"),
  rewindShortcut: byId("rewind-shortcut"),
  usageShortcut: byId("usage-shortcut"),
  fullAccessShortcut: byId("full-access-shortcut"),
  commandMenuButton: byId("command-menu-button"),
  taskButton: byId("task-button"),
};

const state = {
  socket: null,
  generation: 0,
  reconnectTimer: null,
  reconnectAllowed: true,
  authenticated: false,
  token: "",
  projectId: null,
  sessionId: null,
  sessionTitle: "",
  sessionView: "active",
  sessions: [],
  sessionCursor: null,
  sessionLoading: false,
  navigationBusy: false,
  sessionLoadGeneration: 0,
  sessionSearchTimer: null,
  selectionMode: false,
  selectedSessions: new Set(),
  sidebarCollapsed: stateGet(SIDEBAR_COLLAPSED_KEY) === "1",
  mobileSidebarOpen: false,
  noticeAction: null,
  running: false,
  commandBusy: false,
  controlsTask: false,
  fullAccessEnabled: false,
  composerLocksConfirms: false,
  composerFocusTimer: null,
  rewindText: null,
  requestNumber: 0,
  pendingRequests: new Map(),
  pendingUserMessages: [],
  assistantStreams: new Map(),
  commands: new Map(),
};
elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
syncSidebarState();
const slashCommandOptions = {
  input: elements.messageInput,
  element: elements.slashMenu,
  request,
  onResult: addCommandResult,
  onError: (error) => showNotice(errorMessage(error)),
  onBusy: (busy) => {
    state.commandBusy = busy;
    updateControls();
  },
  onInputChanged: () => {
    resizeComposer();
    updateControls();
  },
};
const slashCommands = typeof window.SlashCommandMenu === "function"
  ? new window.SlashCommandMenu(slashCommandOptions)
  : unavailableSlashCommands();

elements.tokenForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const token = elements.tokenInput.value.trim();
  if (!token) {
    elements.loginStatus.textContent = "请输入访问令牌。";
    return;
  }
  state.reconnectAllowed = true;
  void connect(token);
});

elements.changeTokenButton.addEventListener("click", () => {
  if (state.running && !window.confirm("更换令牌会断开连接，并停止当前任务。继续吗？")) {
    return;
  }
  state.reconnectAllowed = false;
  clearTimeout(state.reconnectTimer);
  state.socket?.close(1000, "Change token");
  state.socket = null;
  state.authenticated = false;
  state.token = "";
  removeStored(TOKEN_KEY);
  elements.tokenInput.value = "";
  elements.loginStatus.textContent = "";
  showLogin();
});

elements.projectSelect.addEventListener("change", () => {
  if (state.running) return;
  state.projectId = elements.projectSelect.value || null;
  resetCurrentSession();
  elements.sessionSearchInput.value = "";
  setSessionView("active", false);
  stateSet(PROJECT_KEY, state.projectId ?? "");
  showEmpty("选择以前的会话，或者新建一个会话。");
  void loadSessions();
});

elements.openSidebarButton.addEventListener("click", openSidebar);
elements.collapseSidebarButton.addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);

elements.sessionSearchInput.addEventListener("input", () => {
  clearTimeout(state.sessionSearchTimer);
  state.sessionSearchTimer = setTimeout(() => void loadSessions(), 250);
});

elements.sessionViewBackButton.addEventListener("click", () => {
  setSessionView("active");
});

elements.archivedSessionsButton.addEventListener("click", () => {
  setSessionView("archived");
});

elements.trashSessionsButton.addEventListener("click", () => {
  setSessionView("trash");
});

elements.selectSessionsButton.addEventListener("click", () => {
  setSelectionMode(true);
});

elements.cancelSelectionButton.addEventListener("click", () => {
  setSelectionMode(false);
});

elements.loadMoreSessionsButton.addEventListener("click", () => {
  void loadSessions({ append: true });
});

elements.bulkPrimaryButton.addEventListener("click", () => {
  void runBulkPrimaryAction();
});

elements.bulkTrashButton.addEventListener("click", () => {
  void moveSelectedToTrash();
});

elements.noticeActionButton.addEventListener("click", () => {
  const action = state.noticeAction;
  hideNotice();
  if (action) void action();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.mobileSidebarOpen) closeMobileSidebar();
});

elements.newSessionButton.addEventListener("click", () => {
  void startSession();
});

elements.loadOlderButton.addEventListener("click", () => {
  void loadOlderHistory();
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.running) {
    void stopTask();
  } else {
    void sendMessage();
  }
});

elements.commandMenuButton.addEventListener("click", () => {
  if (elements.messageInput.value.trim()) return;
  elements.messageInput.value = "/";
  resizeComposer();
  slashCommands.handleInput();
  updateControls();
  elements.messageInput.focus();
});

elements.rewindShortcut.addEventListener("click", () => {
  void slashCommands.runShortcut("rewind");
});

elements.usageShortcut.addEventListener("click", () => {
  void slashCommands.runShortcut("usage", "rate-limits");
});

elements.fullAccessShortcut.addEventListener("click", () => {
  void toggleFullAccess();
});

elements.messageInput.addEventListener("input", () => {
  resizeComposer();
  slashCommands.handleInput();
  updateControls();
});

elements.messageInput.addEventListener("focus", () => {
  clearTimeout(state.composerFocusTimer);
  state.composerLocksConfirms = true;
  updateControls();
});

elements.messageInput.addEventListener("blur", () => {
  clearTimeout(state.composerFocusTimer);
  state.composerFocusTimer = setTimeout(() => {
    state.composerLocksConfirms = false;
    updateControls();
  }, COMPOSER_CONFIRM_UNLOCK_MS);
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (slashCommands.handleKeydown(event)) return;
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!state.running) elements.composer.requestSubmit();
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}

window.codexRemoteReady = true;
if (typeof window.codexRemoteMarkReady === "function") {
  window.codexRemoteMarkReady();
} else {
  elements.connectButton.disabled = false;
}

const savedToken = stateGet(TOKEN_KEY);
if (savedToken) {
  elements.tokenInput.value = savedToken;
  elements.loginStatus.textContent = "正在连接 VPS……";
  void connect(savedToken);
} else {
  showLogin();
}

async function connect(token) {
  const generation = ++state.generation;
  clearTimeout(state.reconnectTimer);
  rejectPending(new Error("连接已重新建立。"));

  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }

  state.token = token;
  state.authenticated = false;
  elements.connectButton.disabled = true;
  elements.loginStatus.textContent = "正在连接 VPS……";
  setConnectionStatus("connecting", "正在连接");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("message", (event) => {
    if (generation === state.generation) handleSocketMessage(event.data);
  });

  socket.addEventListener("open", async () => {
    if (generation !== state.generation) return;
    try {
      await request("auth", { token });
      if (generation !== state.generation) return;
      state.authenticated = true;
      stateSet(TOKEN_KEY, token);
      elements.loginStatus.textContent = "";
      elements.connectButton.disabled = false;
      showApp();
      setConnectionStatus("connected", "已连接");
      void slashCommands.load();
      await loadProjects();
    } catch (error) {
      if (generation !== state.generation) return;
      const message = errorMessage(error);
      elements.loginStatus.textContent = message;
      elements.connectButton.disabled = false;
      if (error?.code === "invalid_token") {
        state.reconnectAllowed = false;
        removeStored(TOKEN_KEY);
        showLogin();
      }
    }
  });

  socket.addEventListener("error", () => {
    if (generation === state.generation && !state.authenticated) {
      elements.loginStatus.textContent = "现在无法连接 VPS。";
      elements.connectButton.disabled = false;
    }
  });

  socket.addEventListener("close", () => {
    if (generation !== state.generation) return;
    state.socket = null;
    state.authenticated = false;
    state.running = false;
    state.commandBusy = false;
    state.controlsTask = false;
    hideThinking();
    slashCommands.close();
    rejectPending(new Error("连接已断开。"));
    elements.approvalList.replaceChildren();
    setConnectionStatus("disconnected", "连接已断开");
    updateControls();

    if (state.reconnectAllowed && state.token) {
      if (!elements.appView.hidden) {
        showNotice("连接中断，VPS 会停止正在进行的任务。正在重新连接……");
      }
      state.reconnectTimer = setTimeout(() => {
        void connect(state.token);
      }, RECONNECT_DELAY_MS);
    }
  });
}

function handleSocketMessage(source) {
  let message;
  try {
    message = JSON.parse(String(source));
  } catch {
    showNotice("VPS 返回了一条无法识别的消息。");
    return;
  }

  if (message.type === "response") {
    const pending = state.pendingRequests.get(message.requestId);
    if (!pending) return;
    state.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.data);
    } else {
      const error = new Error(message.error?.message || "请求失败。");
      error.code = message.error?.code;
      pending.reject(error);
    }
    return;
  }

  if (message.type === "error") {
    showNotice(message.error?.message || "连接发生错误。");
    return;
  }

  if (message.type === "event" && message.event) {
    handleServerEvent(message.event);
  }
}

function request(type, payload = {}) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("尚未连接 VPS。"));
  }

  const requestId = `${Date.now().toString(36)}-${++state.requestNumber}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = state.pendingRequests.get(requestId);
      if (!pending) return;
      state.pendingRequests.delete(requestId);
      const error = new Error("VPS 请求超时，正在重新连接。");
      error.code = "request_timeout";
      reject(error);
      if (state.socket === socket) {
        socket.close(4000, "Request timeout");
      }
    }, REQUEST_TIMEOUT_MS);
    state.pendingRequests.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ type, requestId, ...payload }));
  });
}

function rejectPending(error) {
  for (const pending of state.pendingRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.pendingRequests.clear();
}

async function loadProjects() {
  try {
    const data = await request("projects.list");
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    elements.projectSelect.replaceChildren();

    for (const project of projects) {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      elements.projectSelect.append(option);
    }

    if (projects.length === 0) {
      state.projectId = null;
      showEmpty("项目白名单里暂时没有可用项目。");
      updateControls();
      return;
    }

    const savedProject = stateGet(PROJECT_KEY);
    state.projectId = projects.some((project) => project.id === savedProject)
      ? savedProject
      : projects[0].id;
    elements.projectSelect.value = state.projectId;
    stateSet(PROJECT_KEY, state.projectId);
    elements.sessionSearchInput.value = "";
    setSessionView("active", false);
    resetCurrentSession();
    showEmpty("选择以前的会话，或者新建一个会话。");
    await loadSessions();
  } catch (error) {
    showNotice(errorMessage(error));
  }
}

async function loadSessions({ append = false } = {}) {
  if (!state.projectId || !state.authenticated) return;
  const projectId = state.projectId;
  const view = state.sessionView;
  const searchTerm = elements.sessionSearchInput.value.trim();
  const generation = ++state.sessionLoadGeneration;
  state.sessionLoading = true;
  updateControls();
  if (!append) {
    state.sessions = [];
    state.sessionCursor = null;
    renderSessionList();
  }

  try {
    const data = await request("sessions.list", {
      projectId,
      cursor: append ? state.sessionCursor : null,
      view,
      searchTerm: searchTerm || null,
    });
    if (
      generation !== state.sessionLoadGeneration ||
      projectId !== state.projectId || view !== state.sessionView
    ) return;
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    state.sessions = append
      ? mergeSessions(state.sessions, sessions)
      : sessions;
    state.sessionCursor = typeof data?.nextCursor === "string" ? data.nextCursor : null;
    renderSessionList();
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    if (generation === state.sessionLoadGeneration) {
      state.sessionLoading = false;
      renderSessionList();
    }
    updateControls();
  }
}

async function startSession() {
  if (!state.projectId || state.running) return;
  if (state.sessionView !== "active") setSessionView("active", false);
  setNavigationBusy(true);
  hideNotice();
  try {
    const opened = await request("session.start", { projectId: state.projectId });
    applyOpenedSession(opened);
    upsertSession(opened.session);
    renderSessionList();
    closeMobileSidebar();
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    setNavigationBusy(false);
    updateControls();
  }
}

async function resumeSession(sessionId) {
  if (!state.projectId || state.running) return;
  setNavigationBusy(true);
  hideNotice();
  try {
    const opened = await request("session.resume", {
      projectId: state.projectId,
      sessionId,
    });
    applyOpenedSession(opened);
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    setNavigationBusy(false);
    updateControls();
  }
}

function applyOpenedSession(opened) {
  state.sessionId = opened.session.id;
  state.sessionTitle = opened.session.title || "新会话";
  state.running = Boolean(opened.activeTaskId);
  state.controlsTask = Boolean(opened.controlsActiveTask);
  state.fullAccessEnabled = opened.fullAccessEnabled === true;
  stateSet(SESSION_KEY, state.sessionId);
  upsertSession(opened.session);
  renderSessionList();
  updateConversationTitle();
  closeMobileSidebar();
  renderHistory(
    Array.isArray(opened.tasks) ? opened.tasks : [],
    opened.hasOlder === true,
  );

  if (state.running) {
    showThinking();
  } else {
    hideThinking();
  }
  if (state.running && !state.controlsTask) {
    showNotice("这个任务仍在结束过程中，当前连接暂时不能控制它。");
  } else {
    hideNotice();
  }
  updateControls();
}

function setSessionView(view, load = true) {
  state.sessionView = view;
  state.sessions = [];
  state.sessionCursor = null;
  setSelectionMode(false, false);
  elements.sessionViewTitle.textContent = view === "active"
    ? "最近会话"
    : view === "archived"
    ? "已归档"
    : "回收站";
  elements.sessionViewBackButton.hidden = view === "active";
  elements.archivedSessionsButton.dataset.active = String(view === "archived");
  elements.trashSessionsButton.dataset.active = String(view === "trash");
  renderSessionList();
  if (load) void loadSessions();
}

function setSelectionMode(enabled, render = true) {
  state.selectionMode = enabled;
  state.selectedSessions.clear();
  elements.sessionViewTitle.parentElement.hidden = enabled;
  elements.selectionHeading.hidden = !enabled;
  elements.sessionDestinations.hidden = enabled;
  elements.bulkSessionActions.hidden = !enabled;
  if (render) renderSessionList();
  updateSelectionControls();
}

function renderSessionList() {
  elements.sessionList.replaceChildren();
  if (state.sessionLoading && state.sessions.length === 0) {
    const loading = document.createElement("p");
    loading.className = "session-list-empty";
    loading.textContent = "正在加载会话……";
    elements.sessionList.append(loading);
  } else if (state.sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "session-list-empty";
    const searching = Boolean(elements.sessionSearchInput.value.trim());
    empty.textContent = searching
      ? "没有找到匹配的会话。"
      : state.sessionView === "active"
      ? "这个项目还没有会话。"
      : state.sessionView === "archived"
      ? "还没有归档会话。"
      : "回收站是空的。";
    elements.sessionList.append(empty);
  } else {
    for (const session of state.sessions) {
      elements.sessionList.append(createSessionItem(session));
    }
  }
  elements.loadMoreSessionsButton.hidden = !state.sessionCursor;
  updateSelectionControls();
  updateControls();
}

function createSessionItem(session) {
  const item = document.createElement("article");
  item.className = "session-item";
  item.dataset.current = String(session.id === state.sessionId);
  item.dataset.state = session.state || "not_loaded";
  item.setAttribute("role", "listitem");

  if (state.selectionMode) {
    const label = document.createElement("label");
    label.className = "session-select-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedSessions.has(session.id);
    checkbox.disabled = session.state === "active";
    checkbox.setAttribute("aria-label", `选择 ${session.title || "新会话"}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && state.selectedSessions.size >= 100) {
        checkbox.checked = false;
        showNotice("一次最多整理 100 个会话。");
      } else if (checkbox.checked) {
        state.selectedSessions.add(session.id);
      } else {
        state.selectedSessions.delete(session.id);
      }
      updateSelectionControls();
    });
    const text = document.createElement("span");
    appendSessionText(text, session);
    label.append(checkbox, text);
    item.append(label);
    return item;
  }

  const open = document.createElement("button");
  open.className = "session-open";
  open.type = "button";
  open.disabled = state.sessionView !== "active" || state.running;
  appendSessionText(open, session);
  if (state.sessionView === "active") {
    open.addEventListener("click", () => {
      if (session.id !== state.sessionId) void resumeSession(session.id);
      else closeMobileSidebar();
    });
  }
  item.append(open, createSessionMenu(session));
  return item;
}

function appendSessionText(container, session) {
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = session.title || "新会话";
  const preview = document.createElement("span");
  preview.className = "session-item-preview";
  preview.textContent = session.preview || "暂无内容";
  const meta = document.createElement("span");
  meta.className = "session-item-meta";
  if (state.sessionView === "trash") {
    meta.dataset.warning = "true";
    meta.textContent = trashRemainingText(session.purgeAt);
  } else {
    const date = formatDate(session.updatedAt || session.createdAt);
    meta.textContent = session.state === "active"
      ? `运行中${date ? ` · ${date}` : ""}`
      : date;
  }
  container.append(title, preview, meta);
}

function createSessionMenu(session) {
  const button = document.createElement("button");
  button.className = "session-menu-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-label", `选择并整理 ${session.title || "新会话"}`);
  button.textContent = "⋯";
  button.addEventListener("click", () => {
    setSelectionMode(true, false);
    state.selectedSessions.add(session.id);
    renderSessionList();
  });
  return button;
}

function updateSelectionControls() {
  const count = state.selectedSessions.size;
  elements.selectionCount.textContent = `已选择 ${count} 项`;
  elements.bulkPrimaryButton.disabled = count === 0 || state.sessionLoading;
  elements.bulkTrashButton.disabled = count === 0 || state.sessionLoading;
  elements.bulkPrimaryButton.textContent = state.sessionView === "active" ? "归档" : "恢复";
  elements.bulkTrashButton.hidden = state.sessionView === "trash";
  elements.bulkSessionActions.dataset.single = String(state.sessionView === "trash");
}

async function runBulkPrimaryAction() {
  const action = state.sessionView === "active"
    ? "archive"
    : state.sessionView === "archived"
    ? "unarchive"
    : "restore-trash";
  await mutateSessions(action, [...state.selectedSessions]);
}

async function moveSelectedToTrash() {
  const sessionIds = [...state.selectedSessions];
  if (sessionIds.length === 0) return;
  if (sessionIds.length > 1 && !window.confirm(
    `将 ${sessionIds.length} 个会话移入回收站，并在 30 天后自动删除。继续吗？`,
  )) return;
  const action = state.sessionView === "archived" ? "trash-archived" : "trash-active";
  await mutateSessions(action, sessionIds);
}

async function mutateSessions(action, sessionIds) {
  if (!state.projectId || sessionIds.length === 0) return;
  const projectId = state.projectId;
  setNavigationBusy(true);
  hideNotice();
  try {
    const result = await request("sessions.mutate", { projectId, sessionIds, action });
    const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    if (
      state.sessionId && succeeded.includes(state.sessionId) &&
      (action === "archive" || action.startsWith("trash-"))
    ) {
      resetCurrentSession();
      showEmpty("选择以前的会话，或者新建一个会话。");
    }
    setSelectionMode(false, false);
    await loadSessions();

    if (succeeded.length > 0) {
      const undoAction = action === "archive"
        ? "unarchive"
        : action.startsWith("trash-")
        ? "restore-trash"
        : null;
      const label = action === "archive"
        ? `已归档 ${succeeded.length} 个会话。`
        : action.startsWith("trash-")
        ? `已将 ${succeeded.length} 个会话移入回收站，30 天后自动删除。`
        : `已恢复 ${succeeded.length} 个会话。`;
      const failureNote = failed.length > 0
        ? ` 另有 ${failed.length} 个未能处理：${failed[0]?.message || "操作失败。"}`
        : "";
      if (undoAction) {
        showActionNotice(`${label}${failureNote}`, "撤销", () =>
          mutateSessions(undoAction, succeeded));
      } else {
        showNotice(`${label}${failureNote}`);
      }
    } else if (failed.length > 0) {
      const first = failed[0]?.message || "操作失败。";
      showNotice(`${failed.length} 个会话未能处理：${first}`);
    }
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    setNavigationBusy(false);
    updateControls();
  }
}

function mergeSessions(existing, incoming) {
  const merged = [...existing];
  const seen = new Set(existing.map((session) => session.id));
  for (const session of incoming) {
    if (!seen.has(session.id)) {
      seen.add(session.id);
      merged.push(session);
    }
  }
  return merged;
}

function upsertSession(session) {
  if (!session?.id || state.sessionView !== "active") return;
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...session };
  else state.sessions.unshift(session);
}

function trashRemainingText(purgeAt) {
  if (typeof purgeAt !== "number" || !Number.isFinite(purgeAt)) return "30 天后自动删除";
  const remaining = purgeAt - Date.now() / 1_000;
  if (remaining <= 0) return "即将自动删除";
  const days = Math.max(1, Math.ceil(remaining / 86_400));
  return `${days} 天后自动删除`;
}

function resetCurrentSession() {
  state.sessionId = null;
  state.sessionTitle = "";
  state.running = false;
  state.controlsTask = false;
  state.fullAccessEnabled = false;
  removeStored(SESSION_KEY);
  updateConversationTitle();
  renderSessionList();
  updateControls();
}

function openSidebar() {
  if (isMobileNavigation()) {
    state.mobileSidebarOpen = true;
    elements.appView.dataset.mobileSidebarOpen = "true";
  } else {
    state.sidebarCollapsed = false;
    elements.appView.dataset.sidebarCollapsed = "false";
    stateSet(SIDEBAR_COLLAPSED_KEY, "0");
  }
  syncSidebarState();
}

function closeSidebar() {
  if (isMobileNavigation()) {
    closeMobileSidebar();
  } else {
    state.sidebarCollapsed = true;
    elements.appView.dataset.sidebarCollapsed = "true";
    stateSet(SIDEBAR_COLLAPSED_KEY, "1");
  }
  syncSidebarState();
}

function closeMobileSidebar() {
  state.mobileSidebarOpen = false;
  elements.appView.dataset.mobileSidebarOpen = "false";
  syncSidebarState();
}

function isMobileNavigation() {
  return window.matchMedia("(max-width: 800px)").matches;
}

function updateConversationTitle() {
  const privateTitle = isMobileNavigation() || state.sidebarCollapsed;
  elements.currentSessionTitle.textContent = privateTitle
    ? "Codex Remote"
    : state.sessionTitle || "Codex Remote";
  elements.collapseSidebarButton.textContent = isMobileNavigation() ? "关闭" : "收起";
}

function syncSidebarState() {
  const sidebarVisible = isMobileNavigation()
    ? state.mobileSidebarOpen
    : !state.sidebarCollapsed;
  elements.sessionSidebar.inert = !sidebarVisible;
  elements.sessionSidebar.setAttribute("aria-hidden", String(!sidebarVisible));
  elements.openSidebarButton.setAttribute("aria-expanded", String(sidebarVisible));
  updateConversationTitle();
}

window.addEventListener("resize", syncSidebarState);

function renderHistory(tasks, hasOlder) {
  clearTimeline();
  state.rewindText = rewindTextFromLatestTask(tasks);
  elements.timeline.append(elements.historyLoader);
  elements.historyLoader.hidden = !hasOlder;
  const rendered = renderTasks(tasks);

  if (rendered === 0 && !hasOlder) {
    showEmpty("这是一个新会话，可以发送第一条消息了。");
  } else {
    scrollToBottom(true);
  }
}

function renderTasks(tasks) {
  let rendered = 0;
  for (const task of tasks) {
    for (const item of Array.isArray(task.items) ? task.items : []) {
      if (item.type === "message") {
        addMessage(item.role, item.text, item.id, false);
        rendered += 1;
      } else if (item.type === "command") {
        completeCommand(item);
        rendered += 1;
      } else if (item.type === "file_change") {
        addFileChange(item);
        rendered += 1;
      }
    }
    if (task.error) {
      addTaskNote(`任务失败：${task.error}`);
      rendered += 1;
    }
  }
  return rendered;
}

async function loadOlderHistory() {
  if (!state.sessionId || !state.authenticated || elements.loadOlderButton.disabled) return;
  const sessionId = state.sessionId;
  const oldHeight = elements.timeline.scrollHeight;
  const oldTop = elements.timeline.scrollTop;
  const existingNodes = new Set(elements.timeline.children);
  elements.loadOlderButton.disabled = true;
  elements.loadOlderButton.textContent = "加载中……";

  try {
    const data = await request("history.older");
    if (sessionId !== state.sessionId) return;
    renderTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    const addedNodes = [...elements.timeline.children]
      .filter((node) => !existingNodes.has(node));
    let anchor = elements.historyLoader;
    for (const node of addedNodes) {
      anchor.after(node);
      anchor = node;
    }
    elements.historyLoader.hidden = data?.hasOlder !== true;
    elements.timeline.scrollTop = oldTop + (elements.timeline.scrollHeight - oldHeight);
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    elements.loadOlderButton.disabled = false;
    elements.loadOlderButton.textContent = "加载更早";
  }
}

async function sendMessage() {
  const text = elements.messageInput.value.trim();
  if (!text || !state.sessionId || state.running || !state.authenticated) return;
  if (await slashCommands.submit(text)) return;

  hideEmpty();
  hideNotice();
  const optimistic = addMessage("user", text, `local-${Date.now()}`, false);
  state.pendingUserMessages.push({ text, element: optimistic });
  elements.messageInput.value = "";
  resizeComposer();
  state.running = true;
  state.controlsTask = true;
  setCurrentSessionState("active");
  showThinking();
  updateControls();
  scrollToBottom(true);

  try {
    await request("message.send", { text });
  } catch (error) {
    const pendingIndex = state.pendingUserMessages.findIndex((pending) =>
      pending.element === optimistic
    );
    if (pendingIndex >= 0) state.pendingUserMessages.splice(pendingIndex, 1);
    // 这条消息没有送到 Codex。撤掉气泡并把原文放回输入框，不要让用户
    // 白写一次——尤其是长消息被后端拒绝或连接刚好断开的时候。
    optimistic.remove();
    state.running = false;
    state.controlsTask = false;
    setCurrentSessionState("idle");
    hideThinking();
    const draft = elements.messageInput.value;
    const restorable = !draft.trim();
    showNotice(restorable
      ? `${errorMessage(error)}消息已经放回输入框。`
      : `${errorMessage(error)}未发送的消息和当前草稿都已保留在输入框。`);
    updateControls();
    restoreComposerText(restorable ? text : `${text}\n\n${draft}`);
  }
}

async function stopTask() {
  if (!state.running || !state.controlsTask) return;
  elements.taskButton.disabled = true;
  elements.taskButton.textContent = "停止中";
  try {
    await request("task.stop");
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    updateControls();
  }
}

async function toggleFullAccess() {
  if (
    !state.sessionId || !state.authenticated || state.running || state.commandBusy
  ) return;
  if (!state.fullAccessEnabled && !window.confirm(
    "Full access 会让 Codex 不受项目沙箱限制地操作 VPS。确定只为当前会话打开吗？",
  )) return;

  state.commandBusy = true;
  updateControls();
  try {
    const result = await request("permissions.full-access.toggle");
    addCommandResult(result);
  } catch (error) {
    showNotice(errorMessage(error));
  } finally {
    state.commandBusy = false;
    updateControls();
  }
}

function handleServerEvent(event) {
  switch (event.type) {
    case "sessions.changed":
      if (event.closedSessionId === state.sessionId) {
        resetCurrentSession();
        showEmpty("这个会话已经移出当前列表。请选择其他会话。");
      }
      if (event.projectId === state.projectId) void loadSessions();
      break;
    case "task.started":
      state.rewindText = null;
      state.running = true;
      setCurrentSessionState("active");
      if (typeof event.controlsActiveTask === "boolean") {
        state.controlsTask = event.controlsActiveTask;
      }
      hideEmpty();
      showThinking();
      updateControls();
      break;
    case "message.user":
      state.rewindText = typeof event.text === "string" && event.text ? event.text : null;
      receiveUserMessage(event);
      showThinking();
      break;
    case "message.delta":
      hideThinking();
      appendAssistantDelta(event.itemId, event.delta || "");
      break;
    case "message.completed":
      hideThinking();
      completeAssistant(event.itemId, event.text || "");
      break;
    case "command.started":
      startCommand(event);
      showThinking("正在执行命令");
      break;
    case "command.output.delta":
      appendCommandOutput(event.itemId, event.delta || "");
      break;
    case "command.completed":
      completeCommand(event);
      showThinking();
      break;
    case "file_change.completed":
      addFileChange(event);
      showThinking();
      break;
    case "task.completed":
      state.running = false;
      state.controlsTask = false;
      setCurrentSessionState("idle");
      hideThinking();
      if (event.error) showNotice(event.error);
      if (event.status === "interrupted") addTaskNote("任务已停止。");
      updateControls();
      break;
    case "task.error":
      if (!event.willRetry) hideThinking();
      showNotice(event.willRetry ? `${event.message} Codex 将重试。` : event.message);
      break;
    case "approval.requested":
      hideThinking();
      addApproval(event.approval);
      break;
    case "approval.resolved":
      removeApproval(event.approvalId);
      if (state.running) showThinking();
      break;
  }
}

function setCurrentSessionState(sessionState) {
  const session = state.sessions.find((candidate) => candidate.id === state.sessionId);
  if (!session) return;
  session.state = sessionState;
  if (sessionState === "active") session.updatedAt = Math.floor(Date.now() / 1_000);
  renderSessionList();
}

function addMessage(role, text, id, buffered) {
  hideEmpty();
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.itemId = id;
  let textElement = null;
  if (buffered) {
    textElement = document.createElement("pre");
    article.append(textElement);
  } else {
    article.append(renderMarkdown(text));
  }
  elements.timeline.append(article);

  if (buffered) {
    state.assistantStreams.set(id, {
      element: article,
      textElement,
      shown: "",
      target: text,
      completed: false,
      markdownRendered: false,
      frame: null,
    });
  }
  return article;
}

function receiveUserMessage(event) {
  if (!event.itemId || !event.text) return;
  const existing = elements.timeline.querySelector(
    `[data-item-id="${CSS.escape(event.itemId)}"]`,
  );
  if (existing) return;

  const pendingIndex = state.pendingUserMessages.findIndex((pending) =>
    pending.text === event.text
  );
  if (pendingIndex >= 0) {
    const [pending] = state.pendingUserMessages.splice(pendingIndex, 1);
    pending.element.dataset.itemId = event.itemId;
  } else {
    addMessage("user", event.text, event.itemId, false);
    scrollToBottom(false);
  }
}

function appendAssistantDelta(itemId, delta) {
  if (!itemId || !delta) return;
  let stream = state.assistantStreams.get(itemId);
  if (!stream) {
    addMessage("assistant", "", itemId, true);
    stream = state.assistantStreams.get(itemId);
  }
  stream.target += delta;
  stream.element.classList.add("pending");
  scheduleAssistantFrame(stream);
}

function completeAssistant(itemId, text) {
  let stream = state.assistantStreams.get(itemId);
  if (!stream) {
    addMessage("assistant", "", itemId, true);
    stream = state.assistantStreams.get(itemId);
  }
  if (!text.startsWith(stream.shown)) {
    stream.shown = "";
    stream.textElement.textContent = "";
  }
  stream.target = text;
  stream.completed = true;
  stream.element.classList.add("pending");
  scheduleAssistantFrame(stream);
}

function scheduleAssistantFrame(stream) {
  if (stream.frame !== null) return;
  stream.frame = requestAnimationFrame(() => animateAssistant(stream));
}

function animateAssistant(stream) {
  stream.frame = null;
  // 已经渲染成 Markdown 之后，纯文本节点就不在页面里了。此时再来的增量
  // 必须重新整体渲染，否则会写进一个已经脱离文档的节点，内容凭空消失。
  if (stream.markdownRendered) {
    const stickToBottom = isNearBottom();
    stream.shown = stream.target;
    stream.element.replaceChildren(renderMarkdown(stream.target));
    if (stickToBottom) scrollToBottom(false);
    return;
  }
  const remaining = stream.target.length - stream.shown.length;
  if (remaining <= 0) {
    if (stream.completed) {
      const stickToBottom = isNearBottom();
      stream.element.classList.remove("pending");
      if (!stream.markdownRendered) {
        stream.element.replaceChildren(renderMarkdown(stream.target));
        stream.markdownRendered = true;
        if (stickToBottom) scrollToBottom(false);
      }
    }
    return;
  }

  const stickToBottom = isNearBottom();
  let amount = Math.min(80, Math.max(1, Math.ceil(remaining / 24)));
  const end = stream.shown.length + amount;
  const lastCode = stream.target.charCodeAt(end - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) amount += 1;
  stream.shown = stream.target.slice(0, stream.shown.length + amount);
  stream.textElement.textContent = stream.shown;
  if (stickToBottom) scrollToBottom(false);
  scheduleAssistantFrame(stream);
}

function startCommand(event) {
  hideEmpty();
  if (state.commands.has(event.itemId)) return;
  const details = document.createElement("details");
  details.className = "command";
  details.dataset.itemId = event.itemId;
  const summary = document.createElement("summary");
  const output = document.createElement("pre");
  summary.textContent = `命令：${event.command || "（未知）"} · 运行中`;
  output.textContent = "等待输出……";
  details.append(summary, output);
  elements.timeline.append(details);
  state.commands.set(event.itemId, {
    details,
    summary,
    outputElement: output,
    command: event.command || "（未知）",
    output: "",
    truncated: false,
  });
  scrollToBottom(false);
}

function appendCommandOutput(itemId, delta) {
  const command = state.commands.get(itemId);
  if (!command) return;
  command.output += delta;
  if (command.output.length > MAX_COMMAND_OUTPUT) {
    command.output = command.output.slice(-MAX_COMMAND_OUTPUT);
    command.truncated = true;
  }
  command.outputElement.textContent = `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`;
}

function completeCommand(event) {
  if (!state.commands.has(event.id ?? event.itemId)) {
    startCommand({
      itemId: event.id ?? event.itemId,
      command: event.command,
    });
  }
  const itemId = event.id ?? event.itemId;
  const command = state.commands.get(itemId);
  if (!command) return;
  command.command = event.command || command.command;
  const status = commandStatus(event.status);
  const exit = typeof event.exitCode === "number" ? `，退出码 ${event.exitCode}` : "";
  command.summary.textContent = `命令：${command.command} · ${status}${exit}`;
  if (typeof event.output === "string") {
    command.output = event.output.length > MAX_COMMAND_OUTPUT
      ? event.output.slice(-MAX_COMMAND_OUTPUT)
      : event.output;
    command.truncated = event.outputTruncated === true || event.output.length > MAX_COMMAND_OUTPUT;
  }
  command.outputElement.textContent = command.output
    ? `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`
    : "没有输出。";
}

function addFileChange(event) {
  hideEmpty();
  const note = document.createElement("p");
  note.className = "file-change";
  note.textContent = `文件改动完成：${event.changedFiles ?? 0} 个文件。`;
  elements.timeline.append(note);
  scrollToBottom(false);
}

function addTaskNote(text) {
  const note = document.createElement("p");
  note.className = "task-note";
  note.textContent = text;
  elements.timeline.append(note);
  scrollToBottom(false);
}

function addCommandResult(result) {
  if (!result || typeof result.title !== "string") return;
  if (result.kind === "rewind") {
    const rewindText = state.rewindText;
    renderHistory(
      Array.isArray(result.tasks) ? result.tasks : [],
      result.hasOlder === true,
    );
    if (rewindText !== null && !elements.messageInput.value.trim()) {
      restoreComposerText(rewindText);
    }
  } else if (result.kind === "task") {
    state.rewindText = null;
  }
  hideEmpty();
  hideNotice();
  const article = document.createElement("article");
  article.className = "command-result";
  const title = document.createElement("strong");
  title.textContent = result.title;
  article.append(title);
  for (const line of Array.isArray(result.lines) ? result.lines : []) {
    const text = document.createElement("p");
    if (
      line && typeof line === "object" && line.kind === "timestamp" &&
      typeof line.timestamp === "number" && Number.isFinite(line.timestamp)
    ) {
      text.textContent = `${typeof line.before === "string" ? line.before : ""}${formatDate(line.timestamp)}${typeof line.after === "string" ? line.after : ""}`;
    } else {
      text.textContent = typeof line === "string" ? line : "";
    }
    article.append(text);
  }
  elements.timeline.append(article);
  if (typeof result.sessionName === "string") {
    state.sessionTitle = result.sessionName;
    const session = state.sessions.find((candidate) => candidate.id === state.sessionId);
    if (session) session.title = result.sessionName;
    renderSessionList();
    updateConversationTitle();
  }
  if (typeof result.fullAccessEnabled === "boolean") {
    state.fullAccessEnabled = result.fullAccessEnabled;
    updateControls();
  }
  if (result.kind === "task" && !state.running) {
    state.running = true;
    state.controlsTask = true;
    showThinking();
    updateControls();
  } else {
    scrollToBottom(false);
  }
}
function addApproval(approval) {
  if (!approval?.id || elements.approvalList.querySelector(`[data-approval-id="${CSS.escape(approval.id)}"]`)) {
    return;
  }
  const card = document.createElement("section");
  card.className = "approval-card";
  card.dataset.approvalId = approval.id;
  const description = document.createElement("p");
  description.textContent = approval.reason || (approval.kind === "command"
    ? "Codex 请求执行一项操作。"
    : "Codex 请求修改文件。");
  const detail = document.createElement("small");
  detail.textContent = approval.network
    ? `网络访问：${approval.network.protocol}://${approval.network.host}`
    : "请选择本次允许，或拒绝。";
  description.append(detail);

  const decline = document.createElement("button");
  decline.className = "danger";
  decline.type = "button";
  decline.textContent = "拒绝";
  const approve = document.createElement("button");
  approve.className = "primary";
  approve.type = "button";
  approve.textContent = "本次允许";
  decline.addEventListener("click", () => void answerApproval(card, approval.id, "decline"));
  approve.addEventListener("click", () => void answerApproval(card, approval.id, "approve_once"));
  card.append(description, decline, approve);
  elements.approvalList.append(card);
}

async function answerApproval(card, approvalId, decision) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await request("approval.answer", { approvalId, decision });
    if (state.running) showThinking();
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showNotice(errorMessage(error));
  }
}

function removeApproval(approvalId) {
  const selector = `[data-approval-id="${CSS.escape(approvalId)}"]`;
  elements.approvalList.querySelector(selector)?.remove();
}

function updateControls() {
  const connected = state.authenticated;
  const hasSession = Boolean(state.sessionId);
  const hasText = Boolean(elements.messageInput.value.trim());
  const busy = state.running || state.commandBusy;
  const navigationBusy = state.navigationBusy || state.sessionLoading;
  elements.projectSelect.disabled = !connected || busy || navigationBusy || state.selectionMode;
  elements.newSessionButton.disabled = !connected || busy || navigationBusy ||
    state.selectionMode || !state.projectId;
  elements.sessionSearchInput.disabled = !connected || navigationBusy ||
    state.selectionMode || !state.projectId;
  elements.selectSessionsButton.disabled = !connected || busy || navigationBusy ||
    !state.sessions.some((session) => session.state !== "active");
  elements.loadMoreSessionsButton.disabled = !connected || navigationBusy;
  elements.sessionViewBackButton.disabled = !connected || navigationBusy;
  elements.archivedSessionsButton.disabled = !connected || navigationBusy;
  elements.trashSessionsButton.disabled = !connected || navigationBusy;
  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    const itemIsActive = item.dataset.state === "active";
    for (const button of item.querySelectorAll("button")) {
      const cannotOpen = button.classList.contains("session-open") &&
        state.sessionView !== "active";
      button.disabled = navigationBusy || busy || itemIsActive || cannotOpen;
    }
    for (const checkbox of item.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = navigationBusy || busy || itemIsActive;
    }
  }
  elements.messageInput.disabled = !connected || !hasSession;
  elements.messageInput.placeholder = !hasSession
    ? "先选择或新建会话"
    : state.running
    ? "可以先写，当前回复结束后再发送"
    : state.commandBusy
    ? "快捷操作执行中，可以继续写"
    : "在浏览器里写好，再发送给 Codex";
  const confirmLocked = state.composerLocksConfirms;
  elements.commandMenuButton.disabled = !connected || !hasSession || busy || hasText;
  elements.rewindShortcut.disabled = !connected || !hasSession || busy || confirmLocked;
  elements.rewindShortcut.title = confirmLocked
    ? "请先点开输入框再回退"
    : "";
  elements.usageShortcut.disabled = !connected || !hasSession || state.commandBusy;
  elements.fullAccessShortcut.disabled = !connected || !hasSession || busy || confirmLocked;
  elements.fullAccessShortcut.setAttribute("aria-pressed", String(state.fullAccessEnabled));
  elements.fullAccessShortcut.title = confirmLocked
    ? "请先点开输入框再切换权限"
    : state.fullAccessEnabled
    ? "关闭 Full access，恢复当前会话的默认权限"
    : "仅为当前会话打开 Full access";
  elements.taskButton.textContent = state.running ? "停止" : "发送";
  elements.taskButton.classList.toggle("primary", !state.running);
  elements.taskButton.classList.toggle("danger", state.running);
  elements.taskButton.disabled = state.running
    ? !connected || !state.controlsTask
    : !connected || !hasSession || state.commandBusy || !hasText;
}

function setNavigationBusy(busy) {
  state.navigationBusy = busy;
  updateControls();
}

function clearTimeline() {
  for (const stream of state.assistantStreams.values()) {
    if (stream.frame !== null) cancelAnimationFrame(stream.frame);
  }
  state.assistantStreams.clear();
  state.commands.clear();
  state.pendingUserMessages.length = 0;
  state.rewindText = null;
  slashCommands.close();
  elements.historyLoader.hidden = true;
  hideThinking();
  elements.timeline.replaceChildren();
  elements.approvalList.replaceChildren();
}

function showEmpty(text) {
  clearTimeline();
  elements.emptyState.querySelector("p").textContent = text;
  elements.timeline.append(elements.emptyState);
}

function hideEmpty() {
  if (elements.emptyState.parentElement) elements.emptyState.remove();
}

function showThinking(label = "正在思考") {
  hideEmpty();
  elements.thinkingLabel.textContent = label;
  elements.timeline.append(elements.thinkingIndicator);
  elements.thinkingIndicator.hidden = false;
  scrollToBottom(false);
}

function hideThinking() {
  elements.thinkingIndicator.hidden = true;
}

function resizeComposer() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, window.innerHeight * 0.34)}px`;
}

function rewindTextFromLatestTask(tasks) {
  const latest = tasks.at(-1);
  if (latest?.restoresInput !== true || !Array.isArray(latest.items)) return null;
  const userMessage = latest.items.find((item) =>
    item?.type === "message" && item.role === "user"
  );
  return typeof userMessage?.text === "string" && userMessage.text
    ? userMessage.text
    : null;
}

function restoreComposerText(text) {
  elements.messageInput.value = text;
  resizeComposer();
  updateControls();
  requestAnimationFrame(() => {
    elements.messageInput.focus();
    elements.messageInput.setSelectionRange(text.length, text.length);
  });
}

function isNearBottom() {
  const distance = elements.timeline.scrollHeight - elements.timeline.scrollTop - elements.timeline.clientHeight;
  return distance < 140;
}

function scrollToBottom(force) {
  if (force || isNearBottom()) {
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
  }
}

function showLogin() {
  elements.loginView.hidden = false;
  elements.appView.hidden = true;
  elements.tokenInput.focus();
}

function showApp() {
  elements.loginView.hidden = true;
  elements.appView.hidden = false;
  updateControls();
}

function setConnectionStatus(status, text) {
  elements.connectionStatus.dataset.state = status;
  elements.connectionStatus.textContent = text;
}

function showNotice(text) {
  state.noticeAction = null;
  elements.noticeText.textContent = text;
  elements.noticeActionButton.hidden = true;
  elements.noticeActionButton.textContent = "";
  elements.notice.hidden = false;
}

function showActionNotice(text, actionLabel, action) {
  state.noticeAction = action;
  elements.noticeText.textContent = text;
  elements.noticeActionButton.textContent = actionLabel;
  elements.noticeActionButton.hidden = false;
  elements.notice.hidden = false;
}

function hideNotice() {
  state.noticeAction = null;
  elements.notice.hidden = true;
  elements.noticeText.textContent = "";
  elements.noticeActionButton.hidden = true;
  elements.noticeActionButton.textContent = "";
}

function commandStatus(status) {
  return status === "completed"
    ? "完成"
    : status === "failed"
    ? "失败"
    : status === "declined"
    ? "已拒绝"
    : status === "inProgress"
    ? "运行中"
    : status || "结束";
}

function formatDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "请求失败。";
}

function stateGet(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function stateSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 浏览器禁用本地存储时，当前页面仍可继续使用。
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // 同上。
  }
}

function unavailableSlashCommands() {
  return {
    async load() {},
    close() {
      elements.slashMenu.hidden = true;
      elements.slashMenu.replaceChildren();
    },
    handleInput() {},
    handleKeydown() {
      return false;
    },
    async submit() {
      return false;
    },
    async runShortcut(name) {
      showNotice(`快捷命令 /${name} 当前不可用。`);
    },
  };
}

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少元素：${id}`);
  return element;
}

function slashMenuElement() {
  const existing = document.getElementById("slash-menu");
  if (existing) return existing;

  const element = document.createElement("div");
  element.id = "slash-menu";
  element.className = "slash-menu";
  element.setAttribute("role", "listbox");
  element.hidden = true;
  byId("composer").prepend(element);
  return element;
}
