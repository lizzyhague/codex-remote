import { renderMarkdown, sanitizeHref } from "./markdown.js";
import { createNoticeController, NOTICE_DURATION_MS } from "./notice.js";
import {
  DISPLAY_TIMEZONE_KEY,
  deviceTimeZone,
  formatDisplayTime,
  loadDisplayTimezonePreference,
  normalizeDisplayTimezonePreference,
  resolveDisplayTimeZone,
  saveDisplayTimezonePreference,
} from "./display-timezone.js";
import { projectDisplayLabel } from "./project-labels.js";
import {
  normalizeMcpFormSchema,
  validateMcpFormAnswers,
} from "./mcp-form.js";
import {
  RecoveryStateError,
  RecoveryStateStore,
  acceptMessageDelivery,
  beginMessageDelivery,
  beginRewind,
  completeRewind,
  composerDraft,
  recoverMessageDelivery,
  setComposerDraft,
} from "./recovery-state.js";

const LEGACY_TOKEN_KEY = "codex-remote.token";
const PROJECT_KEY = "codex-remote.project";
const OUTBOX_KEY = "codex-remote.outbox-v2";
const REWIND_OUTBOX_KEY = "codex-remote.rewind-outbox-v1";
const ATTACHMENT_DRAFTS_KEY = "codex-remote.attachment-drafts-v1";
const RECOVERY_KEY = "codex-remote.recovery-v1";
const SIDEBAR_COLLAPSED_KEY = "codex-remote.sidebar-collapsed";
const RECONNECT_DELAY_MS = 2_500;
const REQUEST_TIMEOUT_MS = 15_000;
const SESSION_LOADING_RETRY_MS = 1_000;
const MAX_COMMAND_OUTPUT = 100_000;
const TOOL_TITLE_LIMIT = 72;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 100;
const TEMPORARY_INFO = Object.freeze({ lifetime: "temporary", tone: "info" });
const TEMPORARY_WARNING = Object.freeze({ lifetime: "temporary", tone: "warning" });
const TEMPORARY_ERROR = Object.freeze({ lifetime: "temporary", tone: "error" });
const CONNECTION_NOTICE_KEY = "connection";
const RECOVERY_NOTICE_KEY = "recovery-storage";

const recoveryStore = new RecoveryStateStore(localStorage, {
  key: RECOVERY_KEY,
  legacy: {
    messages: OUTBOX_KEY,
    rewinds: REWIND_OUTBOX_KEY,
    attachmentDrafts: ATTACHMENT_DRAFTS_KEY,
  },
});
let recoveryProblemSignature = null;
const volatileComposerDrafts = new Map();

const elements = {
  loginView: byId("login-view"),
  tokenForm: byId("token-form"),
  tokenInput: byId("token-input"),
  connectButton: byId("connect-button"),
  loginStatus: byId("login-status"),
  appView: byId("app-view"),
  connectionStatus: byId("connection-status"),
  sessionMetrics: byId("session-metrics"),
  currentSessionTitle: byId("current-session-title"),
  sessionSidebar: byId("session-sidebar"),
  conversationShell: byId("conversation-shell"),
  openSidebarButton: byId("open-sidebar-button"),
  collapseSidebarButton: byId("collapse-sidebar-button"),
  appSettingsButton: byId("app-settings-button"),
  appSettingsDialog: byId("app-settings-dialog"),
  appSettingsForm: byId("app-settings-form"),
  appSettingsCloseButton: byId("app-settings-close-button"),
  appSettingsCancelButton: byId("app-settings-cancel-button"),
  appSettingsSaveButton: byId("app-settings-save-button"),
  appSettingsStatus: byId("app-settings-status"),
  defaultModelSelect: byId("default-model-select"),
  defaultReasoningEffortSelect: byId("default-reasoning-effort-select"),
  defaultPermissionsSelect: byId("default-permissions-select"),
  defaultPermissionsStatus: byId("default-permissions-status"),
  modelDefaultsInfoButton: byId("model-defaults-info-button"),
  modelDefaultsStatus: byId("model-defaults-status"),
  developerInstructionsInput: byId("developer-instructions-input"),
  developerInstructionsInfoButton: byId("developer-instructions-info-button"),
  followDeviceTimezoneInput: byId("follow-device-timezone-input"),
  displayTimezoneCitySelect: byId("display-timezone-city-select"),
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
  selectAllSessionsButton: byId("select-all-sessions-button"),
  sessionList: byId("session-list"),
  loadMoreSessionsButton: byId("load-more-sessions-button"),
  sessionDestinations: byId("session-destinations"),
  archivedSessionsButton: byId("archived-sessions-button"),
  trashSessionsButton: byId("trash-sessions-button"),
  bulkSessionActions: byId("bulk-session-actions"),
  bulkPrimaryButton: byId("bulk-primary-button"),
  bulkTrashButton: byId("bulk-trash-button"),
  appAlertDialog: byId("app-alert-dialog"),
  appAlertTitle: byId("app-alert-title"),
  appAlertMessage: byId("app-alert-message"),
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
  noticeCloseButton: byId("notice-close-button"),
  composer: byId("composer"),
  slashMenu: slashMenuElement(),
  messageInput: byId("message-input"),
  attachmentInput: byId("attachment-input"),
  attachmentList: byId("attachment-list"),
  commandMenuButton: byId("command-menu-button"),
  taskButton: byId("task-button"),
  composerPickerMenu: byId("composer-picker-menu"),
  modelPickerButton: byId("model-picker-button"),
  modelPickerLabel: byId("model-picker-label"),
  permissionPickerButton: byId("permission-picker-button"),
  permissionPickerLabel: byId("permission-picker-label"),
  renameDialog: byId("rename-dialog"),
  renameForm: byId("rename-form"),
  renameInput: byId("rename-input"),
  renameStatus: byId("rename-status"),
  renameCancelButton: byId("rename-cancel"),
  renameSaveButton: byId("rename-save"),
};

// 两个选择入口共用一套结构；注册表保持扁平，按 kind 取元素走这里。
const composerPickers = {
  model: { button: elements.modelPickerButton, label: elements.modelPickerLabel },
  permission: { button: elements.permissionPickerButton, label: elements.permissionPickerLabel },
};

const state = {
  socket: null,
  generation: 0,
  reconnectTimer: null,
  reconnectAllowed: true,
  authenticated: false,
  connectionReady: false,
  projectId: null,
  projects: [],
  sessionId: null,
  sessionTitle: "",
  metrics: null,
  sessionOpenState: null,
  sessionResumeTimer: null,
  sessionResumeInFlight: false,
  sessionView: "active",
  sessions: [],
  markedSessions: [],
  sessionCursor: null,
  sessionLoading: false,
  sessionLoadError: null,
  navigationBusy: false,
  sessionLoadGeneration: 0,
  openGeneration: 0,
  openIntent: null,
  pickerGeneration: 0,
  sessionSearchTimer: null,
  selectionMode: false,
  /** 会话 ID → 选中时所在列表里的摘要；只含当前项目、当前视图、当前列表里可整理的项。 */
  selectedSessions: new Map(),
  sidebarCollapsed: stateGet(SIDEBAR_COLLAPSED_KEY) === "1",
  /** 已保存的显示时区；设置对话框里未保存的改动只放在 draft 里预览。 */
  displayTimezone: loadDisplayTimezonePreference(),
  displayTimezoneDraft: null,
  developerInstructions: "",
  defaultModel: null,
  defaultReasoningEffort: null,
  defaultModelDraft: null,
  defaultReasoningEffortDraft: null,
  settingsModels: [],
  settingsModelsState: "idle",
  settingsModelsError: "",
  modelDefaultsMessage: "",
  defaultPermissions: null,
  defaultPermissionsDraft: null,
  settingsPermissions: [],
  settingsPermissionsState: "idle",
  settingsPermissionsError: "",
  appSettingsLoadGeneration: 0,
  appSettingsBusy: false,
  mobileSidebarOpen: false,
  running: false,
  stopping: false,
  commandBusy: false,
  controlsTask: false,
  rewindTargetTurnId: null,
  rewindText: null,
  rewindAttachments: [],
  pendingAttachments: [],
  composerProjectId: null,
  composerSessionId: null,
  attachmentUploads: new Map(),
  requestNumber: 0,
  pendingRequests: new Map(),
  pendingUserMessages: [],
  assistantStreams: new Map(),
  commands: new Map(),
};
const noticeController = createNoticeController({
  element: elements.notice,
  textElement: elements.noticeText,
  actionButton: elements.noticeActionButton,
  closeButton: elements.noticeCloseButton,
  onActionError: (error) => showNotice(errorMessage(error), TEMPORARY_ERROR),
});
elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
syncSidebarState();
syncAppSettingsForm();
const slashCommandOptions = {
  input: elements.messageInput,
  element: elements.slashMenu,
  button: elements.commandMenuButton,
  request: requestSlashCommand,
  onResult: (result) => { addCommandResult(result); void refreshPickerLabels(); },
  onRename: openRenameDialog,
  actions: [
    { label: "添加附件", description: "上传图片、PDF 或文本，可一次选择多个文件。", disabled: () => state.pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS, onSelect: () => elements.attachmentInput.click() },
    { label: "重命名", description: "修改当前会话的名称。", onSelect: () => openRenameDialog() },
  ],
  onError: (error) => showNotice(errorMessage(error), TEMPORARY_ERROR),
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

elements.projectSelect.addEventListener("change", () => {
  invalidateOpenIntent();
  persistCurrentComposerDraft();
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
elements.appSettingsButton.addEventListener("click", () => {
  void openAppSettings();
});
elements.appSettingsCloseButton.addEventListener("click", closeAppSettings);
elements.appSettingsCancelButton.addEventListener("click", closeAppSettings);
elements.appSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAppSettings();
});
elements.appSettingsDialog.addEventListener("cancel", (event) => {
  if (state.appSettingsBusy) event.preventDefault();
});
elements.appSettingsDialog.addEventListener("close", () => {
  closeFieldInfoPopovers();
  discardDisplayTimezoneDraft();
  setAppSettingsStatus("");
});
elements.followDeviceTimezoneInput.addEventListener("change", previewDisplayTimezonePreference);
elements.displayTimezoneCitySelect.addEventListener("change", previewDisplayTimezonePreference);
elements.defaultModelSelect.addEventListener("change", () => {
  const nextModel = elements.defaultModelSelect.value || null;
  const selected = state.settingsModels.find((model) => model.id === nextModel);
  const effort = state.defaultReasoningEffortDraft;
  const effortStillSupported = !effort || selected?.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === effort,
  );
  state.defaultModelDraft = nextModel;
  state.modelDefaultsMessage = "";
  if (nextModel === null) {
    state.defaultReasoningEffortDraft = null;
  } else if (!effortStillSupported) {
    state.defaultReasoningEffortDraft = null;
    state.modelDefaultsMessage = "原先的思考强度不适用于这个模型，已改为跟随模型默认。";
  }
  renderModelDefaults();
});
elements.defaultReasoningEffortSelect.addEventListener("change", () => {
  state.defaultReasoningEffortDraft = elements.defaultReasoningEffortSelect.value || null;
  state.modelDefaultsMessage = "";
  renderModelDefaults();
});
elements.defaultPermissionsSelect.addEventListener("change", () => {
  state.defaultPermissionsDraft = elements.defaultPermissionsSelect.value || null;
  renderPermissionDefaults();
});
window.addEventListener("storage", (event) => {
  if (event.key !== DISPLAY_TIMEZONE_KEY) return;
  applyStoredDisplayTimezone();
});

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

elements.selectAllSessionsButton.addEventListener("click", () => {
  toggleSelectAllSessions();
});

elements.loadMoreSessionsButton.addEventListener("click", () => {
  void loadSessions({ append: true });
});

elements.bulkPrimaryButton.addEventListener("click", () => {
  void runBulkPrimaryAction();
});

elements.bulkTrashButton.addEventListener("click", () => {
  void runBulkDangerAction();
});

document.addEventListener("keydown", closeMobileSidebarOnEscape);

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
  closeComposerPicker();
  slashCommands.toggleAll();
});

elements.attachmentInput.addEventListener("change", () => {
  const files = [...elements.attachmentInput.files];
  elements.attachmentInput.value = "";
  void uploadFiles(files);
});

elements.messageInput.addEventListener("input", () => {
  persistCurrentComposerDraft();
  resizeComposer();
  closeComposerPicker();
  slashCommands.handleInput();
  updateControls();
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (slashCommands.handleKeydown(event)) return;
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!state.running) elements.composer.requestSubmit();
  }
});

window.codexRemoteReady = true;
if (typeof window.codexRemoteMarkReady === "function") {
  window.codexRemoteMarkReady();
} else {
  elements.connectButton.disabled = false;
}

removeStored(LEGACY_TOKEN_KEY);
elements.loginStatus.textContent = "正在连接主机……";
void connect();

async function connect(token) {
  const generation = ++state.generation;
  state.connectionReady = false;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  rejectPending(new Error("连接已重新建立。"));

  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }

  state.authenticated = false;
  updateControls();
  elements.connectButton.disabled = true;
  elements.loginStatus.textContent = "正在连接主机……";
  setConnectionStatus("connecting", "正在连接");

  try {
    let response;
    try {
      response = token
        ? await fetch("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        })
        : await fetch("/auth/session", { cache: "no-store" });
    } catch {
      throw new Error(
        "没有收到服务器响应。请求可能未到达服务器，或者连接在服务器响应前中断。请检查网络或代理设置后重试。",
      );
    }
    if (generation !== state.generation) return;
    if (response.status === 401) {
      state.reconnectAllowed = false;
      elements.connectButton.disabled = false;
      showLogin();
      elements.loginStatus.textContent = token ? "访问令牌不正确。" : "请登录。";
      return;
    }
    if (!response.ok) throw new Error("登录服务暂时不可用。");
    const authentication = await response.json();
    if (generation !== state.generation) return;
    elements.tokenInput.value = "";
    const returnTo = new URLSearchParams(location.search).get("returnTo");
    if (returnTo?.startsWith("/view?")) {
      const target = new URL(returnTo, location.origin);
      if (target.origin === location.origin && target.pathname === "/view") {
        location.replace(target.href);
        return;
      }
    }
  } catch (error) {
    if (generation !== state.generation) return;
    elements.loginStatus.textContent = errorMessage(error);
    elements.connectButton.disabled = false;
    setConnectionStatus("disconnected", "连接已断开");
    scheduleReconnect();
    return;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;

  socket.addEventListener("message", (event) => {
    if (generation === state.generation) handleSocketMessage(event.data);
  });

  socket.addEventListener("open", async () => {
    if (generation !== state.generation) return;
    try {
      state.authenticated = true;
      elements.loginStatus.textContent = "";
      elements.connectButton.disabled = false;
      showApp();
      setConnectionStatus("connecting", "正在恢复连接");
      void slashCommands.load();
      await loadProjects(generation);
      if (generation !== state.generation || socket.readyState !== WebSocket.OPEN) return;
      if (state.sessionId) {
        const projectId = state.projectId;
        const sessionId = state.sessionId;
        const openGeneration = beginOpenIntent(projectId, sessionId);
        let opened;
        try {
          opened = await request("session.resume", {
            projectId,
            sessionId,
            acceptLoadingStates: true,
          });
        } catch (error) {
          // 恢复期间会话被另一台设备移走：页面已经退回会话列表，连接本身没有问题。
          if (openGeneration === state.openGeneration) throw error;
        } finally {
          finishOpenIntent(openGeneration);
        }
        if (generation !== state.generation || socket.readyState !== WebSocket.OPEN) return;
        // 打开意图已作废时不应用迟到结果，但连接照常完成恢复。
        if (openGeneration === state.openGeneration) {
          if (projectId !== state.projectId || sessionId !== state.sessionId) return;
          applySessionResumeResult(opened, sessionId, {
            preserveAttachments: true,
            retryDeferred: false,
          });
          if (opened.notice) showNotice(opened.notice, {
            lifetime: "persistent",
            tone: "warning",
            key: "host-memory-degraded",
          });
        }
      }
      state.connectionReady = true;
      updateControls();
      await flushQueuedAttachments();
      await retryDeferredActionsForCurrentSession();
      if (generation !== state.generation || socket.readyState !== WebSocket.OPEN) return;
      setConnectionStatus("connected", "已连接");
      clearNotice(CONNECTION_NOTICE_KEY);
      updateControls();
    } catch (error) {
      if (generation !== state.generation) return;
      const message = errorMessage(error);
      elements.loginStatus.textContent = message;
      elements.connectButton.disabled = false;
      showNotice(`${message}正在重新连接，当前会话和附件已保留。`, {
        lifetime: "state",
        tone: "warning",
        key: CONNECTION_NOTICE_KEY,
      });
      socket.close();
    }
  });

  socket.addEventListener("error", () => {
    if (generation === state.generation && !state.authenticated) {
      elements.loginStatus.textContent = "现在无法连接主机。";
      elements.connectButton.disabled = false;
    }
  });

  socket.addEventListener("close", () => {
    if (generation !== state.generation) return;
    state.metrics = null;
    renderSessionMetrics();
    state.socket = null;
    state.authenticated = false;
    state.connectionReady = false;
    state.running = false;
    state.stopping = false;
    state.commandBusy = false;
    state.controlsTask = false;
    clearSessionResumeTimer();
    hideThinking();
    slashCommands.close();
    rejectPending(new Error("连接已断开。"));
    elements.approvalList.replaceChildren();
    setConnectionStatus("disconnected", "连接已断开");
    updateControls();

    if (state.reconnectAllowed) {
      if (!elements.appView.hidden) {
        showNotice("连接中断；已接受的任务会由主机后台继续处理。正在重新连接……", {
          lifetime: "state",
          tone: "warning",
          key: CONNECTION_NOTICE_KEY,
        });
      }
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (!state.reconnectAllowed || state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connect();
  }, RECONNECT_DELAY_MS);
}

function handleSocketMessage(source) {
  let message;
  try {
    message = JSON.parse(String(source));
  } catch {
    showNotice("主机返回了一条无法识别的消息。", TEMPORARY_ERROR);
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
    showNotice(message.error?.message || "连接发生错误。", TEMPORARY_ERROR);
    return;
  }

  if (message.type === "event" && message.event) {
    handleServerEvent(message.event);
  }
}

function request(type, payload = {}) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("尚未连接主机。"));
  }

  const requestId = `${Date.now().toString(36)}-${++state.requestNumber}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = state.pendingRequests.get(requestId);
      if (!pending) return;
      state.pendingRequests.delete(requestId);
      const error = new Error("主机请求超时，正在重新连接。");
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

async function loadProjects(generation = state.generation) {
  const data = await request("projects.list");
  if (generation !== state.generation) return;
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  state.projects = projects;
  elements.projectSelect.replaceChildren();

  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = projectDisplayLabel(project, projects);
    elements.projectSelect.append(option);
  }

  const savedProject = state.projectId || stateGet(PROJECT_KEY);
  const savedAvailable = projects.some((project) => project.id === savedProject);
  // 列表读取成功就是后端的权威白名单；扫描失败会让请求本身失败，走重连。
  // 缺了当前会话的项目时退出挂载（草稿按原会话保存），不再留着它反复重连。
  if (state.sessionId && !savedAvailable) {
    invalidateOpenIntent();
    resetCurrentSession();
    showNotice("当前会话所在的项目已不可用，已退出该会话。", TEMPORARY_WARNING);
  }

  if (projects.length === 0) {
    state.projectId = null;
    state.sessions = [];
    state.markedSessions = [];
    state.sessionCursor = null;
    state.sessionLoadError = null;
    renderSessionList();
    showEmpty("项目白名单里暂时没有可用项目。");
    updateControls();
    return;
  }

  state.projectId = savedAvailable ? savedProject : projects[0].id;
  elements.projectSelect.value = state.projectId;
  stateSet(PROJECT_KEY, state.projectId);
  if (!state.sessionId) {
    elements.sessionSearchInput.value = "";
    setSessionView("active", false);
    resetCurrentSession();
    showEmpty("选择以前的会话，或者新建一个会话。");
  }
  await loadSessions();
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
    state.markedSessions = [];
    state.sessionCursor = null;
    state.sessionLoadError = null;
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
    const marked = Array.isArray(data?.marked) ? data.marked : [];
    state.sessions = append
      ? mergeSessions(state.sessions, sessions)
      : sessions;
    state.markedSessions = view === "active" ? marked : [];
    state.sessionCursor = typeof data?.nextCursor === "string" ? data.nextCursor : null;
    reconcileSelectedSessions();
    syncCurrentSessionTitle();
    renderSessionList();
  } catch (error) {
    if (
      generation !== state.sessionLoadGeneration ||
      projectId !== state.projectId || view !== state.sessionView
    ) return;
    if (append) {
      showNotice(errorMessage(error), TEMPORARY_ERROR);
    } else {
      // 列表已经清空；失败必须画成错误态，不能落到“还没有会话”这类权威空文案。
      state.sessionLoadError = errorMessage(error);
      reconcileSelectedSessions();
    }
  } finally {
    if (generation === state.sessionLoadGeneration) {
      state.sessionLoading = false;
      renderSessionList();
    }
    updateControls();
  }
}

/** 页面发起一次新建或打开；更早的在途打开随之作废。 */
function beginOpenIntent(projectId, sessionId) {
  const generation = ++state.openGeneration;
  state.openIntent = { generation, projectId, sessionId };
  return generation;
}

function invalidateOpenIntent() {
  state.openGeneration += 1;
  state.openIntent = null;
}

/** 返回 true 表示没有更新的打开在途，调用方可以解除导航锁。 */
function finishOpenIntent(generation) {
  if (state.openIntent && state.openIntent.generation !== generation) return false;
  state.openIntent = null;
  return true;
}

/**
 * 另一台设备归档、回收或删除了正在打开的目标：作废这次打开并退回“还没选会话”，
 * 不再等迟到的结果。目标还没在后端挂上时事件不带 closedSessionId，只能由这里收口。
 */
function cancelRemovedOpenIntent(event) {
  const intent = state.openIntent;
  if (
    !intent || intent.sessionId === null || intent.projectId !== event.projectId ||
    !["archive", "trash", "delete"].includes(event.change) ||
    !Array.isArray(event.sessionIds) || !event.sessionIds.includes(intent.sessionId)
  ) return false;
  invalidateOpenIntent();
  setNavigationBusy(false);
  resetCurrentSession();
  showEmpty("这个会话已经移出当前列表。请选择其他会话。");
  return true;
}

async function startSession() {
  if (!state.projectId) return;
  if (state.sessionView !== "active") setSessionView("active", false);
  const generation = beginOpenIntent(state.projectId, null);
  setNavigationBusy(true);
  clearSessionResumeTimer();
  state.sessionOpenState = null;
  showSessionLoading();
  try {
    const opened = await request("session.start", { projectId: state.projectId });
    if (generation !== state.openGeneration) return;
    applyOpenedSession(opened);
    upsertSession(opened.session);
    renderSessionList();
    closeMobileSidebar();
    if (opened.notice) showNotice(opened.notice, {
      lifetime: "persistent",
      tone: "warning",
      key: "host-memory-degraded",
    });
    if (opened.settingsNotice) showNotice(opened.settingsNotice, TEMPORARY_WARNING);
  } catch (error) {
    if (generation !== state.openGeneration) return;
    showNotice(errorMessage(error), TEMPORARY_ERROR);
    // 旧会话已经撤下来了，没法再把它放回去；与其让输入框对着一个看不见的
    // 会话，不如退回“还没选会话”。
    resetCurrentSession();
    showEmpty("选择以前的会话，或者新建一个会话。");
  } finally {
    if (finishOpenIntent(generation)) setNavigationBusy(false);
    updateControls();
  }
}

async function resumeSession(sessionId) {
  const selected = findSessionSummary(sessionId);
  if (selected && !directoryAvailable(selected.projectId)) {
    showAlert("这个会话的工作目录已经不在了。", "无法打开会话");
    return;
  }
  if (selected?.projectId && selected.projectId !== state.projectId) {
    persistCurrentComposerDraft();
    state.projectId = selected.projectId;
    stateSet(PROJECT_KEY, state.projectId);
    elements.projectSelect.value = state.projectId;
    await loadSessions();
  }
  if (!state.projectId) return;
  const switching = sessionId !== state.sessionId;
  const generation = beginOpenIntent(state.projectId, sessionId);
  setNavigationBusy(true);
  clearSessionResumeTimer();
  state.sessionOpenState = null;
  // 切换期间把旧会话的内容撤下来。留着的话，停止、发送、加载更早都还点得动，
  // 而这些请求认的是连接当前打开的会话——切换一旦先到，它们就落到新会话上了。
  if (switching) showSessionLoading();
  try {
    const opened = await request("session.resume", {
      projectId: state.projectId,
      sessionId,
      acceptLoadingStates: true,
    });
    // 等待期间目标可能已被另一台设备移走，或页面有了新的导航意图；
    // 迟到的结果不能把页面重新画回这个会话。
    if (generation !== state.openGeneration) return;
    applySessionResumeResult(opened, sessionId);
    if (opened.notice) showNotice(opened.notice, {
      lifetime: "persistent",
      tone: "warning",
      key: "host-memory-degraded",
    });
  } catch (error) {
    if (generation !== state.openGeneration) return;
    showNotice(errorMessage(error), TEMPORARY_ERROR);
    if (switching) {
      resetCurrentSession();
      showEmpty("选择以前的会话，或者新建一个会话。");
    }
  } finally {
    if (finishOpenIntent(generation)) setNavigationBusy(false);
    updateControls();
  }
}

function applySessionResumeResult(opened, sessionId, options = {}) {
  if (opened?.loadState === "queued" || opened?.loadState === "starting") {
    applyLoadingSession(opened, sessionId, options);
    return false;
  }
  applyOpenedSession(opened, options);
  return true;
}

function applyLoadingSession(
  loading,
  sessionId,
  { preserveAttachments = false } = {},
) {
  const preserveComposer = preserveAttachments &&
    state.composerProjectId === state.projectId && state.composerSessionId === sessionId;
  if (!preserveComposer) persistCurrentComposerDraft();
  const previousSessionId = state.sessionId;
  if (state.sessionId && state.sessionId !== sessionId) {
    clearCurrentSessionNotice(state.sessionId);
  }
  if (!preserveAttachments) abortAttachmentUploads();
  clearSessionResumeTimer();
  state.metrics = null;
  state.sessionId = sessionId;
  state.sessionOpenState = loading.loadState;
  state.sessionTitle = findSessionSummary(sessionId)?.title ||
    (previousSessionId === sessionId ? state.sessionTitle : "") || "会话";
  state.running = true;
  state.stopping = false;
  state.controlsTask = loading.controlsActiveTask === true;
  if (!preserveComposer) loadComposerDraftForCurrentSession();
  renderSessionMetrics();
  setCurrentSessionState("active");
  updateConversationTitle();
  closeMobileSidebar();
  showSessionLoading(loading.loadState);
  scheduleLoadingSessionResume();
  updateControls();
}

function clearSessionResumeTimer() {
  if (state.sessionResumeTimer !== null) clearTimeout(state.sessionResumeTimer);
  state.sessionResumeTimer = null;
}

function scheduleLoadingSessionResume(delay = SESSION_LOADING_RETRY_MS) {
  clearSessionResumeTimer();
  if (!state.sessionOpenState || !state.sessionId || !state.projectId || !state.authenticated) return;
  state.sessionResumeTimer = setTimeout(() => {
    state.sessionResumeTimer = null;
    void refreshLoadingSession();
  }, delay);
}

async function refreshLoadingSession() {
  if (
    state.sessionResumeInFlight || !state.sessionOpenState || !state.sessionId ||
    !state.projectId || !state.authenticated
  ) return;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  state.sessionResumeInFlight = true;
  try {
    const opened = await request("session.resume", {
      projectId,
      sessionId,
      acceptLoadingStates: true,
    });
    if (projectId !== state.projectId || sessionId !== state.sessionId || !state.sessionOpenState) {
      return;
    }
    applySessionResumeResult(opened, sessionId, {
      preserveAttachments: true,
      retryDeferred: false,
    });
  } catch (error) {
    if (state.authenticated && projectId === state.projectId && sessionId === state.sessionId) {
      showNotice(errorMessage(error), TEMPORARY_ERROR);
    }
  } finally {
    state.sessionResumeInFlight = false;
    if (projectId === state.projectId && sessionId === state.sessionId && state.sessionOpenState) {
      scheduleLoadingSessionResume();
    }
  }
}

function applyOpenedSession(opened, { preserveAttachments = false, retryDeferred = true } = {}) {
  const preserveComposer = preserveAttachments &&
    state.composerProjectId === state.projectId && state.composerSessionId === opened.session.id;
  if (!preserveComposer) persistCurrentComposerDraft();
  if (state.sessionId && state.sessionId !== opened.session.id) {
    clearCurrentSessionNotice(state.sessionId);
  }
  if (!preserveAttachments) abortAttachmentUploads();
  clearSessionResumeTimer();
  state.metrics = null;
  state.sessionOpenState = null;
  state.sessionId = opened.session.id;
  void refreshPickerLabels();
  renderSessionMetrics();
  state.sessionTitle = opened.session.title || "新会话";
  state.running = Boolean(opened.activeTaskId);
  state.controlsTask = Boolean(opened.controlsActiveTask);
  if (!state.running) state.stopping = false;
  if (!preserveComposer) loadComposerDraftForCurrentSession();
  upsertSession(opened.session);
  renderSessionList();
  updateConversationTitle();
  closeMobileSidebar();
  renderHistory(
    Array.isArray(opened.tasks) ? opened.tasks : [],
    opened.hasOlder === true,
  );
  for (const event of Array.isArray(opened.replayEvents) ? opened.replayEvents : []) {
    handleServerEvent(event, true);
  }
  void refreshSessionMetrics();

  if (state.running) {
    showThinking();
  } else {
    hideThinking();
  }
  if (state.running && !state.controlsTask) {
    showNotice("这个任务仍在结束过程中，当前连接暂时不能控制它。", {
      lifetime: "state",
      tone: "warning",
      key: taskNoticeKey("control"),
    });
  } else {
    clearNotice(taskNoticeKey("control"));
  }
  updateControls();
  if (retryDeferred) void retryDeferredActionsForCurrentSession();
}

function setSessionView(view, load = true) {
  state.sessionView = view;
  state.sessions = [];
  state.markedSessions = [];
  state.sessionCursor = null;
  state.sessionLoadError = null;
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
  const marked = state.sessionView === "active" ? state.markedSessions : [];
  if (marked.length > 0) {
    const group = document.createElement("div");
    group.className = "session-mark-group";
    for (const session of marked) group.append(createSessionItem(session));
    const divider = document.createElement("hr");
    divider.className = "session-mark-divider";
    elements.sessionList.append(group, divider);
  }
  const listEmpty = state.sessions.length === 0 && marked.length === 0;
  if (state.sessionLoading && listEmpty) {
    const loading = document.createElement("p");
    loading.className = "session-list-empty";
    loading.textContent = "正在加载会话……";
    elements.sessionList.append(loading);
  } else if (state.sessionLoadError && listEmpty) {
    elements.sessionList.append(createSessionLoadError(state.sessionLoadError));
  } else if (state.sessions.length === 0) {
    if (marked.length === 0) {
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
    }
  } else {
    for (const session of state.sessions) {
      elements.sessionList.append(createSessionItem(session));
    }
  }
  elements.loadMoreSessionsButton.hidden = !state.sessionCursor;
  updateSelectionControls();
  updateControls();
}

function createSessionLoadError(message) {
  const container = document.createElement("div");
  container.className = "session-list-empty session-list-error";
  container.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.textContent = `会话列表没有读取成功：${message}`;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "quiet";
  retry.textContent = "重试";
  retry.addEventListener("click", () => {
    void loadSessions();
  });
  container.append(text, retry);
  return container;
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
    const selectable = sessionSelectable(session);
    checkbox.checked = selectable && state.selectedSessions.has(session.id);
    checkbox.disabled = !selectable;
    checkbox.setAttribute("aria-label", `选择 ${session.title || "新会话"}`);
    if (session.state !== "active" && !selectable) {
      label.title = "这个会话属于其他项目，切换到它的项目后再整理。";
    }
    checkbox.addEventListener("change", () => {
      if (checkbox.checked && state.selectedSessions.size >= 100) {
        checkbox.checked = false;
        showNotice("一次最多整理 100 个会话。", TEMPORARY_WARNING);
      } else if (checkbox.checked) {
        state.selectedSessions.set(session.id, session);
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
  open.disabled = state.sessionView !== "active";
  appendSessionText(open, session);
  if (state.sessionView === "active") {
    open.addEventListener("click", () => {
      if (session.id !== state.sessionId) void resumeSession(session.id);
      else closeMobileSidebar();
    });
  }
  item.append(open, createSessionMark(session));
  return item;
}

function appendSessionText(container, session) {
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = session.title || "新会话";
  const project = document.createElement("span");
  project.className = "session-item-project";
  project.textContent = projectDirectoryName(session.projectId);
  const meta = document.createElement("span");
  meta.className = "session-item-meta";
  if (state.sessionView === "trash") {
    meta.dataset.warning = "true";
    meta.textContent = trashRemainingText(session.purgeAt);
  } else {
    const date = formatDate(session.lastReplyAt);
    meta.textContent = date ? `last reply at ${date}` : "no replies yet";
  }
  container.append(title, project, meta);
}

function projectDirectoryName(projectId) {
  return projectDisplayLabel(
    state.projects.find((project) => project.id === projectId),
    state.projects,
  );
}

function createSessionMark(session) {
  const button = document.createElement("button");
  button.className = "session-mark-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-pressed", String(Boolean(session.marked)));
  button.setAttribute(
    "aria-label",
    session.marked
      ? `取消钉住 ${session.title || "新会话"}`
      : `钉住 ${session.title || "新会话"}`,
  );
  button.title = session.marked ? "取消钉住" : "钉住后会一直显示在最近会话顶部";
  button.append(sessionMarkIcon(Boolean(session.marked)));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleSessionMark(session);
    if (!session.marked) openRenameDialog(session);
  });
  return button;
}

function sessionMarkIcon(pinned) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("session-mark-icon");
  /*
   * 两副路径，不是同一副转角度：转了钉头会超出 viewBox 被切掉，斜边在小尺寸下发糊。
   * viewBox 固定 24（路径按 24 网格画），渲染尺寸由 CSS 定在 17px。
   */
  const LOOSE = {
    body: "M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5-1.5l1.5-4l4-4",
    needle: "M9 15l-4.5 4.5",
    cap: "M14.5 4l5.5 5.5",
  };
  const DRIVEN = {
    body: "M9 4v6l-2 4v2h10v-2l-2-4v-6z",
    needle: "M12 16l0 5",
    cap: "M8 4l8 0",
  };
  const shape = pinned ? DRIVEN : LOOSE;
  const body = document.createElementNS("http://www.w3.org/2000/svg", "path");
  body.setAttribute("d", shape.body);
  if (pinned) body.setAttribute("fill", "currentColor");
  const needle = document.createElementNS("http://www.w3.org/2000/svg", "path");
  needle.setAttribute("d", shape.needle);
  const cap = document.createElementNS("http://www.w3.org/2000/svg", "path");
  cap.setAttribute("d", shape.cap);
  svg.append(body, needle, cap);
  return svg;
}

async function toggleSessionMark(session) {
  const projectId = session.projectId || state.projectId;
  if (!projectId) return;
  try {
    const data = await request("session.mark", {
      projectId,
      sessionId: session.id,
      marked: !session.marked,
    });
    if (data?.session) upsertSession(data.session);
    renderSessionList();
  } catch (error) {
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

function findSessionSummary(sessionId) {
  return state.markedSessions.find((session) => session.id === sessionId) ??
    state.sessions.find((session) => session.id === sessionId) ??
    null;
}

function directoryAvailable(projectId) {
  return Boolean(projectId) && state.projects.some((project) => project.id === projectId);
}

function showAlert(message, title = "提示") {
  elements.appAlertTitle.textContent = title;
  elements.appAlertMessage.textContent = message;
  if (!elements.appAlertDialog.open) elements.appAlertDialog.showModal();
}

function visibleSessionSummaries() {
  const seen = new Set();
  const items = [];
  if (state.sessionView === "active") {
    for (const session of state.markedSessions) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      items.push(session);
    }
  }
  for (const session of state.sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    items.push(session);
  }
  return items;
}

/**
 * 批量整理只作用于当前项目：跨项目钉住的会话出现在「最近」顶部，但不能混进
 * 以当前项目为目标的一次请求。
 */
function sessionSelectable(session) {
  return session.state !== "active" &&
    Boolean(state.projectId) && session.projectId === state.projectId;
}

function selectableSessions() {
  return visibleSessionSummaries().filter(sessionSelectable);
}

/** 列表换成新结果后，选择只保留仍在列表里且仍可整理的项，并换成最新摘要。 */
function reconcileSelectedSessions() {
  if (state.selectedSessions.size === 0) return;
  const current = new Map(selectableSessions().map((session) => [session.id, session]));
  const next = new Map();
  for (const id of state.selectedSessions.keys()) {
    const session = current.get(id);
    if (session) next.set(id, session);
  }
  state.selectedSessions = next;
}

/** 当前列表里有正在打开的会话时，让右侧标题跟列表（例如另一台设备的重命名）一致。 */
function syncCurrentSessionTitle() {
  if (!state.sessionId) return;
  const session = visibleSessionSummaries().find((candidate) =>
    candidate.id === state.sessionId && candidate.projectId === state.projectId
  );
  if (!session) return;
  const title = session.title || "新会话";
  if (title === state.sessionTitle) return;
  state.sessionTitle = title;
  updateConversationTitle();
}

function toggleSelectAllSessions() {
  const sessions = selectableSessions();
  const capped = sessions.slice(0, 100);
  const allSelected = capped.length > 0 &&
    capped.every((session) => state.selectedSessions.has(session.id));
  if (allSelected) {
    state.selectedSessions.clear();
  } else {
    state.selectedSessions = new Map(capped.map((session) => [session.id, session]));
    if (sessions.length > 100) showNotice("一次最多整理 100 个会话。", TEMPORARY_WARNING);
  }
  renderSessionList();
}

function updateSelectionControls() {
  const count = state.selectedSessions.size;
  const cappedIds = selectableSessions().map((session) => session.id).slice(0, 100);
  const allSelected = cappedIds.length > 0 &&
    cappedIds.every((id) => state.selectedSessions.has(id));
  elements.selectionCount.textContent = `已选择 ${count} 项`;
  elements.selectAllSessionsButton.textContent = allSelected ? "取消全选" : "全选";
  elements.bulkPrimaryButton.disabled = count === 0 || state.sessionLoading;
  elements.bulkTrashButton.disabled = count === 0 || state.sessionLoading;
  elements.bulkPrimaryButton.textContent = state.sessionView === "active" ? "归档" : "恢复";
  elements.bulkTrashButton.textContent = state.sessionView === "trash" ? "永久删除" : "删除";
}

/**
 * 一次批量操作的对象：提示文字和实际发送都只用这一份。
 * 列表正在刷新时不给对象，等选择和新列表核对过再操作。
 */
function selectedSessionTargets() {
  if (state.sessionLoading || !state.projectId) return null;
  reconcileSelectedSessions();
  const sessions = [...state.selectedSessions.values()];
  if (sessions.length === 0) return null;
  return {
    projectId: state.projectId,
    sessionIds: sessions.map((session) => session.id),
    sessions,
  };
}

async function runBulkPrimaryAction() {
  const targets = selectedSessionTargets();
  if (!targets) return;
  const action = state.sessionView === "active"
    ? "archive"
    : state.sessionView === "archived"
    ? "unarchive"
    : "restore-trash";
  await mutateSessions(action, targets.sessionIds, {
    projectId: targets.projectId,
    fromSelection: true,
  });
}

async function runBulkDangerAction() {
  const targets = selectedSessionTargets();
  if (!targets) return;
  const { sessions, sessionIds, projectId } = targets;
  if (state.sessionView === "trash") {
    if (!window.confirm(
      sessions.length === 1
        ? `立刻永久删除「${sessions[0].title || "新会话"}」。这一步无法撤销，会话原文会一并删除。继续吗？`
        : `立刻永久删除 ${sessions.length} 个会话。这一步无法撤销，会话原文会一并删除。继续吗？`,
    )) return;
    await mutateSessions("delete-trash", sessionIds, { projectId, fromSelection: true });
    return;
  }
  if (sessionIds.length > 1 && !window.confirm(
    `删除 ${sessionIds.length} 个会话。30 天内可以在回收站里还原，到期后自动永久删除。继续吗？`,
  )) return;
  const action = state.sessionView === "archived" ? "trash-archived" : "trash-active";
  await mutateSessions(action, sessionIds, { projectId, fromSelection: true });
}

/** `projectId` 是这组会话所属的项目，撤销沿用它，不跟随页面后来切到的项目。 */
async function mutateSessions(action, sessionIds, { projectId, fromSelection = false }) {
  if (!projectId || sessionIds.length === 0) return;
  setNavigationBusy(true);
  try {
    const result = await request("sessions.mutate", { projectId, sessionIds, action });
    const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    if (
      state.sessionId && succeeded.includes(state.sessionId) &&
      (action === "archive" || action.startsWith("trash-") || action === "delete-trash")
    ) {
      resetCurrentSession();
      showEmpty("选择以前的会话，或者新建一个会话。");
    }
    if (fromSelection) setSelectionMode(false, false);
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
        ? `已删除 ${succeeded.length} 个会话，30 天后自动永久删除。`
        : action === "delete-trash"
        ? `已永久删除 ${succeeded.length} 个会话。`
        : `已恢复 ${succeeded.length} 个会话。`;
      const failureNote = failed.length > 0
        ? ` 另有 ${failed.length} 个未能处理：${failed[0]?.message || "操作失败。"}`
        : "";
      if (undoAction) {
        showActionNotice(`${label}${failureNote}`, "撤销", () =>
          mutateSessions(undoAction, succeeded, { projectId }), {
          tone: failed.length > 0 ? "error" : "info",
        });
      } else {
        showNotice(`${label}${failureNote}`, failed.length > 0
          ? TEMPORARY_ERROR
          : TEMPORARY_INFO);
      }
    } else if (failed.length > 0) {
      const first = failed[0]?.message || "操作失败。";
      showNotice(`${failed.length} 个会话未能处理：${first}`, TEMPORARY_ERROR);
    }
  } catch (error) {
    showNotice(errorMessage(error), TEMPORARY_ERROR);
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
  const markedIndex = state.markedSessions.findIndex((candidate) => candidate.id === session.id);
  const listIndex = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (session.marked) {
    if (listIndex >= 0) state.sessions.splice(listIndex, 1);
    if (markedIndex >= 0) state.markedSessions[markedIndex] = { ...state.markedSessions[markedIndex], ...session };
    else state.markedSessions.unshift(session);
    state.markedSessions.sort((left, right) =>
      (right.updatedAt || 0) - (left.updatedAt || 0) || String(right.id).localeCompare(String(left.id))
    );
    return;
  }
  if (markedIndex >= 0) state.markedSessions.splice(markedIndex, 1);
  if (session.projectId && session.projectId !== state.projectId) return;
  if (listIndex >= 0) state.sessions[listIndex] = { ...state.sessions[listIndex], ...session };
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
  persistCurrentComposerDraft();
  if (state.sessionId) clearCurrentSessionNotice(state.sessionId);
  abortAttachmentUploads();
  clearSessionResumeTimer();
  state.sessionId = null;
  state.sessionOpenState = null;
  closeComposerPicker();
  elements.modelPickerLabel.textContent = "默认";
  elements.permissionPickerLabel.textContent = "默认";
  state.metrics = null;
  renderSessionMetrics();
  state.sessionTitle = "";
  state.running = false;
  state.stopping = false;
  state.controlsTask = false;
  state.pendingAttachments = [];
  state.composerProjectId = null;
  state.composerSessionId = null;
  elements.messageInput.value = "";
  state.rewindTargetTurnId = null;
  state.rewindText = null;
  state.rewindAttachments = [];
  renderAttachmentList();
  resizeComposer();
  updateConversationTitle();
  renderSessionList();
  updateControls();
}

function openSidebar() {
  if (isMobileNavigation()) {
    state.mobileSidebarOpen = true;
    elements.appView.dataset.mobileSidebarOpen = "true";
    syncSidebarState();
    // 抽屉盖住页面后焦点进入侧栏；落在“收起”上，键盘用户一步就能退出。
    elements.collapseSidebarButton.focus();
    return;
  }
  state.sidebarCollapsed = false;
  elements.appView.dataset.sidebarCollapsed = "false";
  stateSet(SIDEBAR_COLLAPSED_KEY, "0");
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
  const wasOpen = state.mobileSidebarOpen;
  state.mobileSidebarOpen = false;
  elements.appView.dataset.mobileSidebarOpen = "false";
  syncSidebarState();
  if (wasOpen && isMobileNavigation()) restoreFocusAfterMobileSidebar();
}

/** 焦点还在侧栏里（或随侧栏变 inert 掉回 body）时交还给汉堡按钮；已被对话框等接走就不抢。 */
function restoreFocusAfterMobileSidebar() {
  const active = document.activeElement;
  if (active && active !== document.body && !elements.sessionSidebar.contains(active)) return;
  elements.openSidebarButton.focus();
}

function closeMobileSidebarOnEscape(event) {
  if (event.key !== "Escape" || !state.mobileSidebarOpen) return;
  // 从侧栏打开的模态对话框自己处理 Escape；侧栏留着，关闭对话框后焦点才有地方回去。
  if (document.querySelector("dialog[open]")) return;
  closeMobileSidebar();
}

function isMobileNavigation() {
  return window.matchMedia("(max-width: 800px)").matches;
}

function updateConversationTitle() {
  const privateTitle = isMobileNavigation() || state.sidebarCollapsed;
  elements.currentSessionTitle.textContent = privateTitle
    ? "Codex Remote"
    : state.sessionTitle || "Codex Remote";
  elements.collapseSidebarButton.textContent = "收起";
}

function syncSidebarState() {
  const sidebarVisible = isMobileNavigation()
    ? state.mobileSidebarOpen
    : !state.sidebarCollapsed;
  elements.sessionSidebar.inert = !sidebarVisible;
  elements.sessionSidebar.setAttribute("aria-hidden", String(!sidebarVisible));
  // 移动端侧栏盖住页面时，被遮住的会话页不可聚焦、不可点、对辅助技术隐藏。
  elements.conversationShell.inert = isMobileNavigation() && state.mobileSidebarOpen;
  elements.openSidebarButton.setAttribute("aria-expanded", String(sidebarVisible));
  updateConversationTitle();
}

window.addEventListener("resize", syncSidebarState);

function renderHistory(tasks, hasOlder) {
  clearTimeline();
  const rewind = rewindDraftFromLatestTask(tasks);
  state.rewindTargetTurnId = rewind.targetTurnId;
  state.rewindText = rewind.text;
  state.rewindAttachments = rewind.attachments;
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
        addMessage(item.role, item.text, item.id, false, publicAttachments(item.attachments));
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
  if (!state.projectId || !state.sessionId || !state.authenticated ||
      elements.loadOlderButton.disabled) return;
  // 切换会话时这个按钮已经随时间线一起撤下去了；这里仍拒绝新的点击。
  // 已发出的请求另外携带它当时看见的项目和会话，后端不匹配就不推进游标。
  if (state.navigationBusy) return;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  const oldHeight = elements.timeline.scrollHeight;
  const oldTop = elements.timeline.scrollTop;
  const existingNodes = new Set(elements.timeline.children);
  elements.loadOlderButton.disabled = true;
  elements.loadOlderButton.textContent = "加载中……";

  try {
    const data = await request("history.older", { projectId, sessionId });
    if (projectId !== state.projectId || sessionId !== state.sessionId) return;
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
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  } finally {
    elements.loadOlderButton.disabled = false;
    elements.loadOlderButton.textContent = "加载更早";
  }
}

async function sendMessage() {
  const text = elements.messageInput.value.trim();
  const attachments = readyAttachments();
  if ((!text && attachments.length === 0) || !state.projectId || !state.sessionId || state.running ||
    !state.connectionReady || hasUnfinishedUploads()) return;
  if (attachments.length === 0 && await slashCommands.submit(text)) return;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  if (!projectId || !sessionId) return;

  const outbox = {
    clientMessageId: createClientMessageId(),
    projectId,
    sessionId,
    text,
    attachmentIds: attachments.map((attachment) => attachment.id),
    attachments: publicAttachments(attachments),
    createdAtMs: Date.now(),
  };
  if (!storeMessageForDelivery(outbox)) {
    showNotice("无法安全保存待发送消息，因此没有发送；正文和附件仍留在输入框。", {
      lifetime: "persistent",
      tone: "error",
      key: RECOVERY_NOTICE_KEY,
      force: true,
    });
    return;
  }

  hideEmpty();
  const optimistic = addMessage("user", text, `local-${Date.now()}`, false, attachments);
  state.pendingUserMessages.push({
    key: userMessageKey(text, attachments),
    element: optimistic,
    taskId: null,
  });
  elements.messageInput.value = "";
  state.pendingAttachments = state.pendingAttachments.filter((attachment) => attachment.status !== "ready");
  renderAttachmentList();
  resizeComposer();
  state.running = true;
  state.controlsTask = true;
  setCurrentSessionState("active");
  showThinking();
  updateControls();
  scrollToBottom(true);

  try {
    await request("message.send", {
      projectId,
      sessionId,
      text,
      clientMessageId: outbox.clientMessageId,
      attachmentIds: outbox.attachmentIds,
    });
    acceptStoredMessage(outbox.clientMessageId);
    clearNotice(deliveryNoticeKey(outbox.clientMessageId));
  } catch (error) {
    const uncertainDelivery = error?.code === "request_timeout" || !state.authenticated;
    if (uncertainDelivery) {
      showNotice("连接在确认消息前中断。消息 ID 已保留；重新打开这个会话后会安全重试。", {
        lifetime: "state",
        tone: "warning",
        key: deliveryNoticeKey(outbox.clientMessageId),
      });
      return;
    }
    const recovered = recoverStoredMessage(outbox);
    const pendingIndex = state.pendingUserMessages.findIndex((pending) =>
      pending.element === optimistic
    );
    if (pendingIndex >= 0) state.pendingUserMessages.splice(pendingIndex, 1);
    // 这条消息没有送到 Codex。撤掉气泡并把原文放回输入框，不要让用户
    // 白写一次——尤其是长消息被后端拒绝或连接刚好断开的时候。
    optimistic.remove();
    if (projectId === state.projectId && sessionId === state.sessionId) {
      state.running = false;
      state.stopping = false;
      state.controlsTask = false;
      setCurrentSessionState("idle");
      hideThinking();
      loadComposerDraftForCurrentSession();
      updateControls();
    }
    showNotice(recovered === "persisted"
      ? `${errorMessage(error)}消息已经放回原会话的输入草稿。`
      : recovered === "volatile"
      ? `${errorMessage(error)}消息仍由当前页面和待确认记录共同保留。`
      : `${errorMessage(error)}消息仍保留在原会话的待确认记录中。`, {
      lifetime: "persistent",
      tone: "error",
      key: deliveryNoticeKey(outbox.clientMessageId),
    });
  }
}

async function uploadFiles(files) {
  // 系统文件选择器返回时连接可能尚未恢复，先接住文件再决定何时上传。
  if (!state.sessionId || !state.projectId || files.length === 0) return;
  const available = MAX_MESSAGE_ATTACHMENTS - state.pendingAttachments.length;
  if (available <= 0) {
    showNotice(`一条消息最多附加 ${MAX_MESSAGE_ATTACHMENTS} 个文件。`, TEMPORARY_WARNING);
    return;
  }
  if (files.length > available) {
    showNotice(`一条消息最多附加 ${MAX_MESSAGE_ATTACHMENTS} 个文件，只处理了前 ${available} 个。`, TEMPORARY_WARNING);
  }
  await Promise.all(files.slice(0, available).map((file) => uploadFile(file)));
}

async function uploadFile(file) {
  const clientId = createClientMessageId();
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  const draft = {
    clientId,
    originalName: file.name || "未命名文件",
    size: file.size,
    status: "preparing",
    statusText: "正在申请上传票据",
    file,
    projectId,
    sessionId,
  };
  state.pendingAttachments.push(draft);
  renderAttachmentList();
  updateControls();
  if (file.size > MAX_ATTACHMENT_BYTES) {
    Object.assign(draft, { status: "failed", statusText: "超过 25 MiB 上限", file: null });
    renderAttachmentList();
    updateControls();
    return;
  }

  await startUpload(draft);
}

async function startUpload(draft) {
  if (!draft.file || !state.pendingAttachments.includes(draft) ||
      state.attachmentUploads.has(draft.clientId)) return;
  if (draft.projectId !== state.projectId || draft.sessionId !== state.sessionId) return;
  if (!state.connectionReady || state.socket?.readyState !== WebSocket.OPEN) {
    Object.assign(draft, { status: "queued", statusText: "等待重新连接" });
    renderAttachmentList();
    updateControls();
    return;
  }

  const { clientId, file, projectId, sessionId } = draft;
  const generation = state.generation;
  const controller = new AbortController();
  state.attachmentUploads.set(clientId, controller);
  Object.assign(draft, { status: "preparing", statusText: "正在申请上传票据" });
  renderAttachmentList();
  updateControls();
  try {
    const ticket = await request("attachment.ticket.create", {
      projectId,
      sessionId,
      originalName: file.name || "未命名文件",
      declaredMime: file.type || "application/octet-stream",
      expectedSize: file.size,
    });
    if (projectId !== state.projectId || sessionId !== state.sessionId) {
      throw new Error("上传期间切换了会话，请重新选择文件。");
    }
    if (controller.signal.aborted || !state.pendingAttachments.includes(draft)) return;
    if (generation !== state.generation || !state.connectionReady) {
      throw new Error("连接已断开。");
    }
    Object.assign(draft, { status: "uploading", statusText: "正在上传" });
    renderAttachmentList();
    const response = await fetch("/attachments/upload", {
      method: "POST",
      headers: { "x-upload-ticket": ticket.ticket },
      body: file,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.error?.message || "附件上传失败。");
      error.code = body?.error?.code;
      throw error;
    }
    if (!body?.attachment?.id) throw new Error("上传服务没有返回附件 ID。");
    if (controller.signal.aborted || !state.pendingAttachments.includes(draft) ||
        projectId !== state.projectId || sessionId !== state.sessionId) return;
    Object.assign(draft, body.attachment, {
      clientId,
      status: "ready",
      statusText: "上传完成",
      file: null,
    });
    persistCurrentComposerDraft();
  } catch (error) {
    if (!controller.signal.aborted && (generation !== state.generation ||
        !state.connectionReady || state.socket?.readyState !== WebSocket.OPEN)) {
      Object.assign(draft, { status: "queued", statusText: "等待重新连接" });
    } else {
      Object.assign(draft, {
        status: "failed",
        statusText: error?.name === "AbortError" ? "已取消" : errorMessage(error),
      });
    }
  } finally {
    state.attachmentUploads.delete(clientId);
    renderAttachmentList();
    updateControls();
    if (draft.status === "queued" && state.connectionReady && !controller.signal.aborted) {
      void startUpload(draft);
    }
  }
}

async function flushQueuedAttachments() {
  await Promise.all(state.pendingAttachments
    .filter((draft) => draft.status === "queued").map((draft) => startUpload(draft)));
}

function hasUnfinishedUploads() {
  return state.attachmentUploads.size > 0 ||
    state.pendingAttachments.some((draft) => draft.status === "queued");
}

function renderAttachmentList() {
  elements.attachmentList.replaceChildren();
  elements.attachmentList.hidden = state.pendingAttachments.length === 0;
  for (const attachment of state.pendingAttachments) {
    const item = document.createElement("div");
    item.className = "attachment-item";
    item.dataset.status = attachment.status;
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = attachment.originalName || "未命名文件";
    const meta = document.createElement("small");
    meta.className = "attachment-meta";
    meta.textContent = attachment.status === "ready"
      ? `${attachment.id} · 上传完成`
      : attachment.statusText || "处理中";
    const remove = document.createElement("button");
    remove.className = "quiet attachment-remove";
    remove.type = "button";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除附件 ${attachment.originalName || "未命名文件"}`);
    remove.addEventListener("click", () => removeAttachment(attachment));
    item.append(name, meta, remove);
    elements.attachmentList.append(item);
  }
}

function removeAttachment(attachment) {
  state.attachmentUploads.get(attachment.clientId)?.abort();
  state.attachmentUploads.delete(attachment.clientId);
  setPendingAttachments(state.pendingAttachments.filter((candidate) => candidate !== attachment));
}

function abortAttachmentUploads() {
  for (const controller of state.attachmentUploads.values()) controller.abort();
  state.attachmentUploads.clear();
}

function readyAttachments() {
  return state.pendingAttachments.filter((attachment) =>
    attachment.status === "ready" && typeof attachment.id === "string");
}

function setPendingAttachments(attachments) {
  state.pendingAttachments = attachments;
  persistCurrentComposerDraft();
  renderAttachmentList();
  updateControls();
}

function mergeAttachments(first, second) {
  const merged = [];
  const seen = new Set();
  for (const attachment of [...first, ...second]) {
    const key = attachment.id || attachment.clientId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(attachment);
  }
  return merged;
}

/** 只用来把乐观气泡和后端事件对上；附件名不参与拼接，也不会被再次解析。 */
function userMessageKey(text, attachments) {
  return JSON.stringify([text, attachments.map((attachment) => attachment.id)]);
}

async function stopTask() {
  if (!state.projectId || !state.sessionId || !state.running ||
      !state.controlsTask || state.stopping) return;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  state.stopping = true;
  elements.taskButton.disabled = true;
  elements.taskButton.textContent = "停止中";
  try {
    const result = await request("task.stop", { projectId, sessionId });
    if (result?.requested === false) {
      state.stopping = false;
      // 压缩指令已经发给模型，后端不会去打断它；时间线没有变化，不必重新载入。
      if (result.reason === "compact_started") {
        showNotice("压缩已经开始，不能中途停止", TEMPORARY_WARNING);
        return;
      }
      if (state.sessionId) await resumeSession(state.sessionId);
      showNotice("任务已经结束或状态已变化", TEMPORARY_WARNING);
      return;
    }
  } catch (error) {
    state.stopping = false;
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  } finally {
    updateControls();
  }
}

function handleServerEvent(event, replay = false) {
  // 后台排队任务在内存读数降级时放行，提示随 task.starting 持久保存；回放时也要再提示。
  if (
    event.type === "task.starting" && event.sessionId === state.sessionId &&
    typeof event.notice === "string" && event.notice
  ) {
    showNotice(event.notice, {
      lifetime: "persistent",
      tone: "warning",
      key: "host-memory-degraded",
    });
  }
  const loadingHandled = handleLoadingSessionEvent(event, replay);
  const pendingRequestEvent = event.type === "approval.requested" ||
    event.type === "approval.resolved" || event.type === "interaction.requested" ||
    event.type === "interaction.resolved";
  if (loadingHandled && !pendingRequestEvent) return;
  if (isTaskProgressEvent(event.type)) {
    clearNotice(taskNoticeKey("retry", event.taskId || event.sessionId));
  }
  switch (event.type) {
    case "task.queued": {
      state.running = true;
      state.controlsTask = true;
      setCurrentSessionState("active");
      const queuedText = typeof event.text === "string" ? event.text : "";
      const queuedAttachments = publicAttachments(event.attachments);
      if (queuedText || queuedAttachments.length > 0) {
        const key = userMessageKey(queuedText, queuedAttachments);
        let pending = state.pendingUserMessages.find((candidate) => candidate.key === key);
        if (!pending) {
          const element = addMessage(
            "user",
            queuedText,
            `queued-${event.taskId}`,
            false,
            queuedAttachments,
          );
          pending = { key, element, taskId: event.taskId };
          state.pendingUserMessages.push(pending);
        }
        pending.taskId = event.taskId;
      }
      showThinking("正在排队");
      updateControls();
      break;
    }
    case "task.starting":
      state.running = true;
      state.controlsTask = true;
      setCurrentSessionState("active");
      showThinking("正在启动 Codex");
      updateControls();
      break;
    case "sessions.changed":
      cancelRemovedOpenIntent(event);
      if (event.closedSessionId === state.sessionId) {
        resetCurrentSession();
        showEmpty("这个会话已经移出当前列表。请选择其他会话。");
      }
      if (
        event.change === "mark" || event.change === "unmark" || event.change === "rename" ||
        event.projectId === state.projectId
      ) {
        void loadSessions();
      }
      break;
    case "task.started":
      state.rewindTargetTurnId = typeof event.nativeTurnId === "string"
        ? event.nativeTurnId
        : null;
      state.rewindText = null;
      state.rewindAttachments = [];
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
      state.rewindAttachments = publicAttachments(event.attachments);
      receiveUserMessage(event);
      showThinking();
      break;
    case "message.delta":
      hideThinking();
      appendAssistantDelta(event.itemId, event.delta || "", event.taskId);
      break;
    case "message.completed":
      hideThinking();
      completeAssistant(event.itemId, event.text || "", event.taskId);
      break;
    case "tool.started":
      sealAssistantStreams(event.taskId);
      hideThinking();
      startTool(event);
      showThinking(event.tool?.kind === "think" ? "正在思考" : "正在执行工具");
      break;
    case "tool.output.delta":
      appendToolOutput(event.itemId, event.delta || "");
      break;
    case "tool.completed":
      completeTool(event);
      if (state.running) showThinking();
      break;
    case "task.completed":
      if (!replay) void refreshSessionMetrics();
      clearNotice(taskNoticeKey("retry", event.taskId || event.sessionId));
      clearNotice(taskNoticeKey("control", event.sessionId));
      finalizeTaskProjection(event.taskId, event.status);
      {
        const pendingIndex = state.pendingUserMessages.findIndex((pending) =>
          pending.taskId === event.taskId
        );
        if (pendingIndex >= 0) state.pendingUserMessages.splice(pendingIndex, 1);
      }
      state.running = false;
      state.controlsTask = false;
      state.stopping = false;
      setCurrentSessionState("idle");
      hideThinking();
      if (event.error) {
        addTaskNote(`任务失败：${event.error}`);
        if (!replay) showNotice(event.error, TEMPORARY_ERROR);
      }
      if (event.status === "interrupted") addTaskNote("任务已停止。");
      updateControls();
      break;
    case "task.error":
      if (!event.willRetry) hideThinking();
      if (event.willRetry) {
        showNotice(`${event.message} Codex 将重试。`, {
          lifetime: "state",
          tone: "warning",
          key: taskNoticeKey("retry", event.taskId || event.sessionId),
        });
      } else if (!replay) {
        showNotice(event.message, TEMPORARY_ERROR);
      }
      break;
    case "approval.requested":
      if (event.sessionId === state.sessionId) hideThinking();
      addApproval(event.approval, event.sourceSession, event.sessionId);
      break;
    case "approval.resolved":
      removeApproval(event.approvalId);
      if (event.sessionId === state.sessionId && state.running) showThinking();
      break;
    case "interaction.requested":
      if (event.sessionId === state.sessionId) hideThinking();
      addInteraction(event.interaction, event.sourceSession, event.sessionId);
      break;
    case "interaction.resolved":
      removeInteraction(event.interactionId);
      if (event.sessionId === state.sessionId && state.running) showThinking();
      break;
  }
}

function handleLoadingSessionEvent(event, replay) {
  if (!state.sessionOpenState || event.sessionId !== state.sessionId) return false;
  if (event.type === "task.queued") {
    state.sessionOpenState = "queued";
    state.running = true;
    state.controlsTask = true;
  } else if (event.type === "task.starting") {
    state.sessionOpenState = "starting";
    state.running = true;
    state.controlsTask = true;
  } else if (
    event.type === "task.started" || event.type === "message.user" ||
    event.type === "message.delta" || event.type === "message.completed" ||
    event.type === "tool.started" || event.type === "tool.output.delta" ||
    event.type === "tool.completed" || event.type === "approval.requested" ||
    event.type === "interaction.requested"
  ) {
    const alreadyRestoring = state.sessionOpenState === "restoring";
    state.sessionOpenState = "restoring";
    state.running = true;
    if (!alreadyRestoring) scheduleLoadingSessionResume(0);
  } else if (event.type === "task.completed") {
    state.sessionOpenState = "loading";
    state.running = false;
    state.controlsTask = false;
    state.stopping = false;
    if (event.error && !replay) showNotice(event.error, TEMPORARY_ERROR);
    scheduleLoadingSessionResume(0);
  } else if (event.type === "task.error") {
    state.sessionOpenState = "restoring";
    scheduleLoadingSessionResume(0);
  } else {
    return false;
  }
  showSessionLoading(state.sessionOpenState);
  updateControls();
  return true;
}

function isTaskProgressEvent(type) {
  return type === "task.queued" || type === "task.starting" || type === "task.started" ||
    type === "message.user" ||
    type === "message.delta" || type === "message.completed" || type === "tool.started" ||
    type === "tool.output.delta" || type === "tool.completed";
}

function taskNoticeKey(kind, contextId = state.sessionId) {
  return `task-${kind}:${contextId || "current"}`;
}

function deliveryNoticeKey(clientMessageId) {
  return `delivery:${clientMessageId}`;
}

function clearCurrentSessionNotice(sessionId) {
  const key = noticeController.current?.key;
  if (
    key === taskNoticeKey("control", sessionId) ||
    key?.startsWith("task-retry:") ||
    key?.startsWith("delivery:")
  ) {
    clearNotice(key);
  }
}

function setCurrentSessionState(sessionState) {
  const session = findSessionSummary(state.sessionId);
  if (!session) return;
  session.state = sessionState;
  if (sessionState === "active") session.updatedAt = Math.floor(Date.now() / 1_000);
  renderSessionList();
}

function addMessage(role, text, id, buffered, attachments = [], taskId = null) {
  hideEmpty();
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.dataset.itemId = id;
  let textElement = null;
  if (buffered) {
    textElement = document.createElement("pre");
    article.append(textElement);
  } else {
    if (text || attachments.length === 0) article.append(renderMarkdown(text));
    if (attachments.length > 0) article.append(renderMessageAttachments(attachments));
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
      taskId,
      taskTerminal: false,
    });
  }
  return article;
}

/** 附件名按文字节点原样显示；换行和控制字符不会被当成 Markdown 或另一条附件。 */
function renderMessageAttachments(attachments) {
  const list = document.createElement("div");
  list.className = "message-attachments";
  for (const attachment of attachments) {
    const chip = document.createElement("span");
    chip.className = "message-attachment";
    chip.textContent = attachment.originalName || "未命名文件";
    list.append(chip);
  }
  return list;
}

function receiveUserMessage(event) {
  const text = typeof event.text === "string" ? event.text : "";
  const attachments = publicAttachments(event.attachments);
  if (!event.itemId || (!text && attachments.length === 0)) return;
  const existing = elements.timeline.querySelector(
    `[data-item-id="${CSS.escape(event.itemId)}"]`,
  );
  if (existing) return;

  const key = userMessageKey(text, attachments);
  const pendingIndex = state.pendingUserMessages.findIndex((pending) =>
    (event.taskId && pending.taskId === event.taskId) || pending.key === key
  );
  if (pendingIndex >= 0) {
    const [pending] = state.pendingUserMessages.splice(pendingIndex, 1);
    pending.element.dataset.itemId = event.itemId;
  } else {
    addMessage("user", text, event.itemId, false, attachments);
    scrollToBottom(false);
  }
}

/**
 * 取这条助手正文的输出流；没有就新建一个气泡。
 *
 * 历史消息是直接渲染好贴上去的，不进流表。被中断那一轮重开时会连同事件一起
 * 重放，同一条正文于是来第二遍——不先看一眼页面就会画成两份。用户气泡一直有
 * 这道检查，这里补上；返回 null 表示页面上已经有了，这一份直接丢掉。
 */
function assistantStreamFor(itemId, taskId = null) {
  const stream = state.assistantStreams.get(itemId);
  if (stream) {
    if (!stream.taskId && taskId) stream.taskId = taskId;
    return stream;
  }
  if (elements.timeline.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`)) return null;
  addMessage("assistant", "", itemId, true, [], taskId);
  return state.assistantStreams.get(itemId);
}

function appendAssistantDelta(itemId, delta, taskId = null) {
  if (!itemId || !delta) return;
  const stream = assistantStreamFor(itemId, taskId);
  if (!stream) return;
  stream.target += delta;
  stream.element.classList.add("pending");
  scheduleAssistantFrame(stream);
}

function sealAssistantStreams(taskId = null, immediate = false) {
  for (const [itemId, stream] of state.assistantStreams) {
    if (taskId && stream.taskId !== taskId) continue;
    if (immediate && stream.target) {
      stream.taskTerminal = true;
      finishAssistantStream(stream);
    } else if (!stream.completed && stream.target) {
      completeAssistant(itemId, stream.target, stream.taskId);
    }
  }
}

function completeAssistant(itemId, text, taskId = null) {
  const stream = assistantStreamFor(itemId, taskId);
  if (!stream) return;
  if (stream.completed && stream.target === text) return;
  if (!text.startsWith(stream.shown)) {
    stream.shown = "";
    stream.textElement.textContent = "";
  }
  stream.target = text;
  stream.completed = true;
  if (stream.taskTerminal) {
    stream.markdownRendered = false;
    finishAssistantStream(stream);
    return;
  }
  stream.element.classList.add("pending");
  scheduleAssistantFrame(stream);
}

function finishAssistantStream(stream) {
  if (stream.completed && stream.frame === null && stream.markdownRendered) {
    stream.element.classList.remove("pending");
    return;
  }
  const stickToBottom = isNearBottom();
  if (stream.frame !== null) cancelAnimationFrame(stream.frame);
  stream.frame = null;
  stream.completed = true;
  stream.shown = stream.target;
  stream.element.classList.remove("pending");
  stream.element.replaceChildren(renderMarkdown(stream.target));
  stream.markdownRendered = true;
  if (stickToBottom) scrollToBottom(false);
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
    if (stream.completed) stream.element.classList.remove("pending");
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

function startTool(event) {
  hideEmpty();
  const itemId = event.itemId ?? event.id;
  if (!itemId || state.commands.has(itemId)) return;
  const tool = publicTool(event.tool);
  const kind = normalizeToolKind(tool.kind);
  if (kind === "think") {
    state.commands.set(itemId, { mode: "hidden", kind, taskId: event.taskId ?? null });
    return;
  }
  const entries = publicToolEntries(tool.entries, kind, tool.title);
  if (entries.length > 0 || isInlineToolKind(kind)) {
    const group = document.createElement("div");
    group.className = "tool-inline-group";
    group.dataset.itemId = itemId;
    elements.timeline.append(group);
    const command = {
      mode: "inline",
      group,
      kind,
      title: tool.title || kind,
      status: tool.status || "inProgress",
      entries,
      taskId: event.taskId ?? null,
      taskTerminalStatus: null,
    };
    state.commands.set(itemId, command);
    renderToolEntry(command);
    scrollToBottom(false);
    return;
  }

  const details = document.createElement("details");
  details.className = "command";
  details.dataset.itemId = itemId;
  details.dataset.kind = kind;
  const summary = document.createElement("summary");
  const pane = document.createElement("div");
  pane.className = "command-pane";
  details.append(summary, pane);
  elements.timeline.append(details);
  const command = {
    mode: "card",
    details,
    summary,
    pane,
    kind,
    title: tool.title || kind,
    status: tool.status || "inProgress",
    input: typeof tool.input === "string" ? tool.input : "",
    query: typeof tool.query === "string" ? tool.query : "",
    resources: publicResources(tool.resources),
    output: typeof tool.output === "string" ? tool.output : "",
    truncated: tool.outputTruncated === true,
    exitCode: typeof tool.exitCode === "number" ? tool.exitCode : null,
    taskId: event.taskId ?? null,
    taskTerminalStatus: null,
  };
  state.commands.set(itemId, command);
  renderToolEntry(command);
  scrollToBottom(false);
}

function appendToolOutput(itemId, delta) {
  const command = state.commands.get(itemId);
  if (!command || command.mode !== "card" || command.kind !== "execute") return;
  command.output += delta;
  if (command.output.length > MAX_COMMAND_OUTPUT) {
    command.output = command.output.slice(-MAX_COMMAND_OUTPUT);
    command.truncated = true;
  }
  if (command.outputElement) command.outputElement.textContent = toolOutputText(command);
}

function completeTool(event) {
  const itemId = event.id ?? event.itemId;
  if (!itemId) return;
  if (!state.commands.has(itemId)) startTool(event);
  const command = state.commands.get(itemId);
  if (!command) return;
  if (!command.taskId && event.taskId) command.taskId = event.taskId;
  const taskTerminalStatus = command.taskTerminalStatus;
  const tool = publicTool(event.tool);
  const nextKind = normalizeToolKind(tool.kind || command.kind);
  if (nextKind === "think") {
    command.details?.remove();
    command.group?.remove();
    state.commands.set(itemId, { mode: "hidden", kind: "think" });
    return;
  }
  command.kind = nextKind;
  if (typeof tool.title === "string" && tool.title) command.title = tool.title;
  if (typeof tool.status === "string" && tool.status) command.status = tool.status;
  if (command.mode === "inline") {
    command.entries = publicToolEntries(tool.entries, nextKind, command.title);
    if (taskTerminalStatus) command.status = taskTerminalStatus;
    renderToolEntry(command);
    return;
  }
  if (typeof tool.input === "string") command.input = tool.input;
  if (typeof tool.query === "string") command.query = tool.query;
  if (Array.isArray(tool.resources)) command.resources = publicResources(tool.resources);
  if (typeof tool.output === "string") {
    command.output = tool.output.length > MAX_COMMAND_OUTPUT
      ? tool.output.slice(-MAX_COMMAND_OUTPUT)
      : tool.output;
    command.truncated = tool.outputTruncated === true || tool.output.length > MAX_COMMAND_OUTPUT;
  }
  if (typeof tool.exitCode === "number") command.exitCode = tool.exitCode;
  if (taskTerminalStatus) command.status = taskTerminalStatus;
  renderToolEntry(command);
}

function finalizeTaskProjection(taskId, taskStatus) {
  if (!taskId) return;
  sealAssistantStreams(taskId, true);
  const toolStatus = taskStatus === "interrupted"
    ? "interrupted"
    : taskStatus === "completed"
    ? "completed"
    : "failed";
  for (const command of state.commands.values()) {
    if (command.taskId !== taskId || !isRunningTool(command)) continue;
    command.status = toolStatus;
    command.taskTerminalStatus = toolStatus;
    renderToolEntry(command);
  }
}

function renderToolEntry(command) {
  if (command.mode === "hidden") return;
  const status = commandStatus(command.status);
  if (command.mode === "inline") {
    command.group.replaceChildren();
    const entries = command.entries.length > 0
      ? command.entries
      : [{ kind: command.kind, title: command.title }];
    for (const entry of entries) {
      const line = document.createElement("p");
      line.className = "tool-inline";
      line.textContent = `${entry.kind} · ${clipTitle(entry.title)} · ${status}`;
      command.group.append(line);
    }
    return;
  }
  command.details.dataset.kind = command.kind;
  const exit = typeof command.exitCode === "number" ? ` · 退出码 ${command.exitCode}` : "";
  command.summary.textContent = `${command.kind} · ${clipTitle(command.title)} · ${status}${exit}`;
  command.pane.replaceChildren();
  command.outputElement = null;
  if (command.kind === "search") {
    appendToolTextBlock(
      command.pane,
      "关键词",
      command.query || (isRunningTool(command) ? "等待关键词……" : "没有可用的关键词。"),
      "command-input",
    );
    appendResourceBlock(command, "结果", "没有可用的结果地址。");
    return;
  }
  if (command.kind === "fetch") {
    appendResourceBlock(command, "地址", "没有可用的资源地址。");
    return;
  }
  appendToolTextBlock(command.pane, "输入", command.input || "没有输入。", "command-input");
  command.outputElement = appendToolTextBlock(
    command.pane,
    "输出",
    toolOutputText(command),
    "command-output",
  );
}

function appendToolTextBlock(pane, label, text, className) {
  const block = document.createElement("div");
  block.className = "command-block";
  const kicker = document.createElement("div");
  kicker.className = "command-kicker";
  kicker.textContent = label;
  const content = document.createElement("pre");
  content.className = className;
  content.textContent = text;
  block.append(kicker, content);
  pane.append(block);
  return content;
}

function appendResourceBlock(command, label, emptyText) {
  const block = document.createElement("div");
  block.className = "command-block";
  const kicker = document.createElement("div");
  kicker.className = "command-kicker";
  kicker.textContent = label;
  block.append(kicker);
  if (!command.resources.length) {
    const empty = document.createElement("p");
    empty.className = "command-resource-empty";
    empty.textContent = isRunningTool(command) ? "等待地址……" : emptyText;
    block.append(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "command-resources";
    for (const resource of command.resources) {
      const item = document.createElement("li");
      const text = resource.label ? `${resource.label} — ${resource.address}` : resource.address;
      const href = externalLinkHref(resource.address);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = text;
        item.append(link);
      } else {
        item.textContent = text;
      }
      list.append(item);
    }
    block.append(list);
  }
  command.pane.append(block);
}

function publicTool(value) {
  return value && typeof value === "object" ? value : {};
}

function publicToolEntries(value, fallbackKind, fallbackTitle) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const kind = normalizeToolKind(entry.kind);
    if (!isInlineToolKind(kind)) return [];
    return [{
      kind,
      title: typeof entry.title === "string" && entry.title.trim()
        ? entry.title
        : fallbackTitle || fallbackKind,
    }];
  });
}

function publicResources(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const resources = [];
  for (const item of value) {
    if (!item || typeof item.address !== "string") continue;
    const address = item.address.trim();
    if (!address || address.length > 2_048 || /[\u0000-\u001f\u007f]/.test(address) || seen.has(address)) {
      continue;
    }
    seen.add(address);
    resources.push({
      address,
      label: typeof item.label === "string"
        ? item.label.replace(/\s+/g, " ").trim().slice(0, 256)
        : "",
    });
  }
  return resources;
}

function isRunningTool(command) {
  return command.status === "inProgress" || command.status === "in_progress" ||
    command.status === "pending";
}

function toolOutputText(command) {
  if (command.output) {
    return `${command.truncated ? "（较早输出已省略）\n" : ""}${command.output}`;
  }
  return isRunningTool(command) ? "等待输出……" : "没有输出。";
}

function normalizeToolKind(kind) {
  return [
    "read", "edit", "delete", "move", "search", "execute",
    "think", "fetch", "switch_mode", "other",
  ].includes(kind) ? kind : "other";
}

function isInlineToolKind(kind) {
  return kind === "read" || kind === "edit" || kind === "delete" ||
    kind === "move" || kind === "switch_mode";
}

function clipTitle(title) {
  const normalized = String(title || "Tool").replace(/\s+/g, " ").trim() || "Tool";
  return normalized.length <= TOOL_TITLE_LIMIT
    ? normalized
    : `${normalized.slice(0, TOOL_TITLE_LIMIT - 1)}…`;
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
  if (result.kind === "task") {
    state.rewindTargetTurnId = null;
    state.rewindText = null;
    state.rewindAttachments = [];
  }
  hideEmpty();
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
      text.dataset.displayTimestamp = String(line.timestamp);
      if (typeof line.before === "string") text.dataset.displayBefore = line.before;
      if (typeof line.after === "string") text.dataset.displayAfter = line.after;
      text.textContent = `${text.dataset.displayBefore ?? ""}${formatDate(line.timestamp)}${text.dataset.displayAfter ?? ""}`;
    } else {
      text.textContent = typeof line === "string" ? line : "";
    }
    article.append(text);
  }
  elements.timeline.append(article);
  if (typeof result.sessionName === "string") {
    state.sessionTitle = result.sessionName;
    const session = findSessionSummary(state.sessionId);
    if (session) session.title = result.sessionName;
    renderSessionList();
    updateConversationTitle();
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
function addApproval(approval, sourceSession = null, sessionId = null) {
  if (!approval?.id || elements.approvalList.querySelector(`[data-approval-id="${CSS.escape(approval.id)}"]`)) {
    return;
  }
  const card = document.createElement("section");
  card.className = "approval-card";
  card.dataset.approvalId = approval.id;
  card.dataset.sessionId = sourceSession?.id || sessionId || "";
  const description = document.createElement("p");
  description.textContent = approval.reason || (approval.kind === "command"
    ? "Codex 请求执行一项操作。"
    : approval.kind === "permissions"
    ? "Codex 请求为本轮增加权限。"
    : "Codex 请求修改文件。");
  const source = document.createElement("small");
  source.textContent = `来源会话：${pendingRequestSessionLabel(sourceSession, sessionId)}`;
  description.append(source);
  for (const line of approvalScopeLines(approval)) {
    const detail = document.createElement("small");
    detail.textContent = line;
    description.append(detail);
  }
  if (approval.canApprove === false) {
    const unavailable = document.createElement("small");
    unavailable.textContent = "完整范围无法在网页中安全显示，只能拒绝。";
    description.append(unavailable);
  }

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
  const actions = document.createElement("div");
  actions.className = "approval-card-actions";
  actions.append(decline);
  if (approval.canApprove !== false) actions.append(approve);
  card.append(description, actions);
  elements.approvalList.append(card);
}

function pendingRequestSessionLabel(sourceSession, fallbackSessionId = null) {
  const sessionId = typeof sourceSession?.id === "string" && sourceSession.id
    ? sourceSession.id
    : fallbackSessionId;
  const title = typeof sourceSession?.title === "string" && sourceSession.title.trim()
    ? sourceSession.title.trim()
    : findSessionSummary(sessionId)?.title || "未命名会话";
  const shortId = typeof sessionId === "string" && sessionId
    ? sessionId.slice(0, 8)
    : "未知";
  return `${title} · ${shortId}`;
}

function approvalScopeLines(approval) {
  const lines = [];
  if (typeof approval.commandSummary === "string" && approval.commandSummary) {
    lines.push(`命令：${approval.commandSummary}`);
  }
  if (
    approval.network && typeof approval.network.protocol === "string" &&
    typeof approval.network.host === "string"
  ) {
    lines.push(`网络访问：${approval.network.protocol}://${approval.network.host}`);
  }
  if (Array.isArray(approval.permissionSummary)) {
    lines.push(...approval.permissionSummary.filter((line) => typeof line === "string"));
  }
  if (lines.length === 0) lines.push("请选择本次允许，或拒绝。");
  return lines;
}

async function requestSlashCommand(type, payload = {}) {
  if (type !== "command.run" || payload.command !== "rewind") {
    if (type !== "command.run") return request(type, payload);
    if (!state.projectId || !state.sessionId) {
      throw new Error("请先打开一个会话。");
    }
    return request(type, {
      ...payload,
      projectId: state.projectId,
      sessionId: state.sessionId,
    });
  }
  const pending = pendingRewindForCurrentSession() ?? beginPendingRewind();
  const result = await request("command.run", {
    ...payload,
    projectId: pending.projectId,
    sessionId: pending.sessionId,
    targetTurnId: pending.targetTurnId,
  });
  await applyRewindResult(result, pending);
  // 结果已经在重新载入的时间线末尾画好，SlashCommandMenu 不必再处理一次。
  return null;
}

function beginPendingRewind() {
  if (!state.projectId || !state.sessionId || !state.rewindTargetTurnId) {
    throw new Error("当前会话没有可以回退的轮次。");
  }
  const pending = {
    projectId: state.projectId,
    sessionId: state.sessionId,
    targetTurnId: state.rewindTargetTurnId,
    text: typeof state.rewindText === "string" ? state.rewindText : null,
    attachments: publicAttachments(state.rewindAttachments),
    createdAtMs: Date.now(),
  };
  if (!storePendingRewind(pending)) {
    throw new Error("无法安全保存回退记录，因此没有执行回退。");
  }
  return pending;
}

async function applyRewindResult(result, pending) {
  if (
    !result || result.kind !== "rewind" ||
    !["reverted", "already_reverted", "stale"].includes(result.outcome) ||
    result.targetTurnId !== pending.targetTurnId
  ) {
    throw new Error("主机返回了无法识别的回退结果。");
  }
  const opened = await request("session.resume", {
    projectId: pending.projectId,
    sessionId: pending.sessionId,
    acceptLoadingStates: true,
  });
  if (
    state.projectId !== pending.projectId ||
    state.sessionId !== pending.sessionId
  ) {
    return;
  }
  const ready = applySessionResumeResult(opened, pending.sessionId, {
    preserveAttachments: true,
    retryDeferred: false,
  });
  if (!ready) {
    throw new Error("回退已经受理，但会话历史尚未准备好；连接恢复后会继续确认。");
  }
  const completed = finishPendingRewind(pending, result.outcome !== "stale");
  if (result.outcome !== "stale") loadComposerDraftForCurrentSession();
  if (completed === "persisted") clearNotice(rewindNoticeKey(pending));
  addCommandResult(result);
  if (opened.notice) showNotice(opened.notice, {
    lifetime: "persistent",
    tone: "warning",
    key: "host-memory-degraded",
  });
}

async function retryPendingRewindForCurrentSession() {
  if (!state.authenticated) return false;
  if (!ensureRecoveryPersisted()) return false;
  let pending;
  try {
    pending = pendingRewindForCurrentSession();
  } catch {
    return false;
  }
  if (!pending) return true;
  const wasBusy = state.commandBusy;
  state.commandBusy = true;
  updateControls();
  try {
    const result = await request("command.run", {
      projectId: pending.projectId,
      sessionId: pending.sessionId,
      command: "rewind",
      option: null,
      argument: null,
      targetTurnId: pending.targetTurnId,
    });
    await applyRewindResult(result, pending);
    return true;
  } catch (error) {
    if (error?.code !== "request_timeout" && state.authenticated) {
      showNotice(`无法确认上一次回退：${errorMessage(error)}`, {
        lifetime: "persistent",
        tone: "error",
        key: rewindNoticeKey(pending),
      });
    }
    return false;
  } finally {
    state.commandBusy = wasBusy;
    updateControls();
  }
}

async function retryDeferredActionsForCurrentSession() {
  if (!await retryPendingRewindForCurrentSession()) return;
  await retryOutboxForCurrentSession();
}

function pendingRewindForCurrentSession() {
  const entries = loadPendingRewinds();
  if (!entries) throw new Error("无法读取浏览器中的回退记录。");
  return entries.find((entry) =>
    entry.projectId === state.projectId && entry.sessionId === state.sessionId
  ) ?? null;
}

function storePendingRewind(entry) {
  return updateRecoveryState(
    (recovery) => beginRewind(recovery, entry),
    { retainOnFailure: false },
  )?.committed === true;
}

function loadPendingRewinds() {
  return readRecoveryState()?.rewinds ?? null;
}

function finishPendingRewind(entry, restoreDraft) {
  const result = updateRecoveryState((recovery) =>
    completeRewind(recovery, entry, restoreDraft)
  );
  return !result ? "failed" : result.persisted ? "persisted" : "volatile";
}

function rewindNoticeKey(entry) {
  return `rewind:${entry.sessionId}:${entry.targetTurnId}`;
}

async function retryOutboxForCurrentSession() {
  if (!state.authenticated) return;
  if (!ensureRecoveryPersisted()) return;
  const entries = loadOutbox();
  if (!entries) return;
  const matches = entries.filter((entry) =>
    entry.projectId === state.projectId && entry.sessionId === state.sessionId
  );
  for (const outbox of matches) {
    try {
      await request("message.send", {
        projectId: outbox.projectId,
        sessionId: outbox.sessionId,
        text: outbox.text,
        clientMessageId: outbox.clientMessageId,
        attachmentIds: outbox.attachmentIds,
      });
      acceptStoredMessage(outbox.clientMessageId);
      clearNotice(deliveryNoticeKey(outbox.clientMessageId));
    } catch (error) {
      if (error?.code !== "request_timeout" && state.authenticated) {
        const recovered = recoverStoredMessage(outbox);
        if (outbox.projectId === state.projectId && outbox.sessionId === state.sessionId) {
          loadComposerDraftForCurrentSession();
        }
        showNotice(recovered === "persisted"
          ? `保留消息重试失败：${errorMessage(error)}消息已放回原会话草稿。`
          : recovered === "volatile"
          ? `保留消息重试失败：${errorMessage(error)}消息仍由当前页面和待确认记录共同保留。`
          : `保留消息重试失败：${errorMessage(error)}原待确认记录没有删除。`, {
          lifetime: "persistent",
          tone: "error",
          key: deliveryNoticeKey(outbox.clientMessageId),
        });
      }
      break;
    }
  }
}

function createClientMessageId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function storeMessageForDelivery(entry) {
  const result = updateRecoveryState(
    (recovery) => beginMessageDelivery(recovery, entry),
    { retainOnFailure: false },
  );
  if (result?.committed) {
    volatileComposerDrafts.delete(composerOwnerKey(entry.projectId, entry.sessionId));
  }
  return result?.committed === true;
}

function loadOutbox() {
  return readRecoveryState()?.messages ?? null;
}

function acceptStoredMessage(clientMessageId) {
  return updateRecoveryState((recovery) =>
    acceptMessageDelivery(recovery, clientMessageId)
  );
}

function recoverStoredMessage(entry) {
  const result = updateRecoveryState((recovery) => recoverMessageDelivery(recovery, entry));
  return !result ? "failed" : result.persisted ? "persisted" : "volatile";
}

function loadComposerDraftForCurrentSession() {
  state.composerProjectId = state.projectId;
  state.composerSessionId = state.sessionId;
  const key = composerOwnerKey(state.projectId, state.sessionId);
  const recovery = readRecoveryState();
  const draft = recovery && state.projectId && state.sessionId
    ? composerDraft(recovery, state.projectId, state.sessionId)
    : key && volatileComposerDrafts.get(key)
    ? volatileComposerDrafts.get(key)
    : { text: "", attachments: [] };
  elements.messageInput.value = draft.text;
  state.pendingAttachments = draft.attachments.map((attachment) => {
    const expired = Number.isFinite(attachment.expiresAtMs) && attachment.expiresAtMs <= Date.now();
    return {
      ...attachment,
      clientId: createClientMessageId(),
      status: expired ? "failed" : "ready",
      statusText: expired ? "附件已过期，请重新添加" : "上传完成",
    };
  });
  renderAttachmentList();
  resizeComposer();
  updateControls();
}

function persistCurrentComposerDraft() {
  if (!state.composerProjectId || !state.composerSessionId) return true;
  const draft = {
    text: elements.messageInput.value,
    attachments: publicAttachments(state.pendingAttachments),
  };
  const key = composerOwnerKey(state.composerProjectId, state.composerSessionId);
  if (draft.text || draft.attachments.length > 0) volatileComposerDrafts.set(key, draft);
  else volatileComposerDrafts.delete(key);
  const result = updateRecoveryState((recovery) => setComposerDraft(
    recovery,
    state.composerProjectId,
    state.composerSessionId,
    draft,
  ));
  if (result?.committed) volatileComposerDrafts.delete(key);
  return result?.committed === true;
}

function composerOwnerKey(projectId, sessionId) {
  return projectId && sessionId ? `${projectId}\n${sessionId}` : null;
}

function publicAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((attachment) =>
    attachment && typeof attachment === "object" &&
    typeof attachment.id === "string" && attachment.id.length <= 128 &&
    typeof attachment.originalName === "string" && attachment.originalName.length <= 1_024
  ).map((attachment) => ({
    id: attachment.id,
    originalName: attachment.originalName,
    size: Number.isFinite(attachment.size) ? attachment.size : NaN,
    declaredMime: typeof attachment.declaredMime === "string" ? attachment.declaredMime : "",
    detectedMime: typeof attachment.detectedMime === "string" ? attachment.detectedMime : "",
    kind: attachment.kind === "image" ? "image" : "file",
    expiresAtMs: Number.isFinite(attachment.expiresAtMs) ? attachment.expiresAtMs : null,
  }));
}

async function answerApproval(card, approvalId, decision) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await request("approval.answer", { approvalId, decision });
    if (state.running && card.dataset.sessionId === state.sessionId) showThinking();
  } catch (error) {
    buttons.forEach((button) => { button.disabled = false; });
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

function removeApproval(approvalId) {
  const selector = `[data-approval-id="${CSS.escape(approvalId)}"]`;
  elements.approvalList.querySelector(selector)?.remove();
}

function addInteraction(interaction, sourceSession = null, sessionId = null) {
  if (
    !interaction?.id ||
    elements.approvalList.querySelector(
      `[data-interaction-id="${CSS.escape(interaction.id)}"]`,
    )
  ) return;
  const card = document.createElement("section");
  card.className = "approval-card";
  card.dataset.interactionId = interaction.id;
  card.dataset.sessionId = sourceSession?.id || sessionId || "";
  const heading = document.createElement("p");
  heading.textContent = "Codex 需要你的输入。";
  const source = document.createElement("small");
  source.textContent = `来源会话：${pendingRequestSessionLabel(sourceSession, sessionId)}`;
  heading.append(source);
  card.append(heading);

  const fields = new Map();
  let canSubmit = true;
  let mcpForm = null;
  if (interaction.kind === "user_input") {
    for (const question of Array.isArray(interaction.questions) ? interaction.questions : []) {
      const label = document.createElement("label");
      label.textContent = question.question || question.header || "请选择";
      let control;
      if (Array.isArray(question.options) && question.options.length > 0) {
        control = document.createElement("select");
        for (const option of question.options) {
          const element = document.createElement("option");
          element.value = option.label;
          element.textContent = option.description
            ? `${option.label} — ${option.description}`
            : option.label;
          control.append(element);
        }
      } else {
        control = document.createElement("input");
        control.type = question.isSecret ? "password" : "text";
      }
      label.append(control);
      card.append(label);
      let other = null;
      if (question.isOther && Array.isArray(question.options)) {
        other = document.createElement("input");
        other.type = question.isSecret ? "password" : "text";
        other.placeholder = "其他回答（可选）";
        card.append(other);
      }
      fields.set(question.id, { control, other, multiple: false });
    }
  } else {
    const message = document.createElement("small");
    message.textContent = `${interaction.serverName || "MCP"}：${interaction.message || "需要确认"}`;
    card.append(message);
    const loginHref = externalLinkHref(interaction.url);
    if (loginHref) {
      const link = document.createElement("a");
      link.href = loginHref;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "打开登录或授权页面";
      card.append(link);
    } else if (typeof interaction.url === "string" && interaction.url) {
      // 地址在，但不是普通网页链接。原样显示让人自己判断，不给它可点的通道，
      // 也不允许确认——没打开过的授权不该回报成已完成。
      const rejected = document.createElement("small");
      rejected.textContent = `这个地址不是网页链接，没有作为链接呈现：${interaction.url}`;
      card.append(rejected);
      canSubmit = false;
    } else {
      mcpForm = normalizeMcpFormSchema(interaction.schema);
      const count = addMcpFormFields(card, fields, mcpForm);
      if (count === 0) {
        const unsupported = document.createElement("small");
        unsupported.textContent = "这个 MCP 表单暂时无法在网页中安全呈现，只能取消本轮。";
        card.append(unsupported);
        canSubmit = false;
      }
    }
  }

  const validation = document.createElement("small");
  validation.className = "interaction-validation";
  validation.role = "alert";
  validation.hidden = true;
  card.append(validation);
  for (const field of fields.values()) {
    const clearValidation = () => {
      for (const candidate of fields.values()) candidate.control.setCustomValidity?.("");
      validation.hidden = true;
      validation.textContent = "";
    };
    field.control.addEventListener("input", clearValidation);
    field.control.addEventListener("change", clearValidation);
  }

  const cancel = document.createElement("button");
  cancel.className = "danger";
  cancel.type = "button";
  cancel.textContent = "取消本轮";
  const submit = document.createElement("button");
  submit.className = "primary";
  submit.type = "button";
  submit.textContent = interaction.kind === "user_input" || interaction.mode !== "url"
    ? "提交回答"
    : "已完成，继续";
  cancel.addEventListener("click", () =>
    void answerInteraction(card, interaction.id, "cancel", {}));
  submit.addEventListener("click", () => {
    let answers;
    if (mcpForm) {
      answers = collectMcpFormAnswers(fields);
      const result = validateMcpFormAnswers(mcpForm, answers);
      if (!result.ok) {
        reportMcpFormError(fields, validation, result);
        return;
      }
    } else {
      answers = {};
      for (const [questionId, field] of fields) {
        const value = field.other?.value.trim() || field.control.value.trim();
        answers[questionId] = value ? [value] : [];
      }
    }
    void answerInteraction(card, interaction.id, "submit", answers);
  });
  const actions = document.createElement("div");
  actions.className = "approval-card-actions";
  actions.append(cancel);
  if (canSubmit) actions.append(submit);
  card.append(actions);
  elements.approvalList.append(card);
}

/**
 * 外部来源的地址能不能作为可点链接呈现。
 *
 * sanitizeHref 已经挡掉 javascript: 之类的协议，这里再要求必须是 http(s)：
 * 这些地址来自 MCP 服务器或工具输出，不是本页自己拼出来的。
 */
function externalLinkHref(value) {
  const href = typeof value === "string" ? sanitizeHref(value) : null;
  return href && /^https?:\/\//i.test(href) ? href : null;
}

function addMcpFormFields(card, fields, form) {
  if (!form || !Array.isArray(form.fields)) return 0;
  let count = 0;
  for (const fieldSchema of form.fields) {
    const fieldId = fieldSchema.id;
    const label = document.createElement("label");
    label.textContent = fieldSchema.title;
    const choices = fieldSchema.choices ?? [];
    let control;
    let multiple = false;
    if (choices.length > 0) {
      control = document.createElement("select");
      multiple = fieldSchema.type === "array";
      control.multiple = multiple;
      if (!multiple) {
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = fieldSchema.required ? "请选择" : "不填写";
        blank.dataset.omit = "true";
        control.append(blank);
      }
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.title;
        option.selected = multiple
          ? Array.isArray(fieldSchema.default) && fieldSchema.default.includes(choice.value)
          : fieldSchema.default === choice.value;
        control.append(option);
      }
    } else if (fieldSchema.type === "boolean") {
      control = document.createElement("select");
      for (const [value, title] of [
        ["", fieldSchema.required ? "请选择" : "不填写"],
        ["true", "是"],
        ["false", "否"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = title;
        if (!value) option.dataset.omit = "true";
        option.selected = fieldSchema.default === (value === "true") && value !== "";
        control.append(option);
      }
    } else if (fieldSchema.type === "string" || fieldSchema.type === "number" ||
      fieldSchema.type === "integer") {
      control = document.createElement("input");
      control.type = fieldSchema.type === "string" ? "text" : "number";
      if (fieldSchema.type === "integer") control.step = "1";
      if (Number.isFinite(fieldSchema.minimum)) control.min = String(fieldSchema.minimum);
      if (Number.isFinite(fieldSchema.maximum)) control.max = String(fieldSchema.maximum);
      if (fieldSchema.default !== undefined) control.value = String(fieldSchema.default);
    } else {
      return 0;
    }
    control.required = fieldSchema.required;
    label.append(control);
    if (typeof fieldSchema.description === "string" && fieldSchema.description) {
      const description = document.createElement("small");
      description.textContent = fieldSchema.description;
      label.append(description);
    }
    card.append(label);
    fields.set(fieldId, { control, other: null, multiple, select: control.tagName === "SELECT" });
    count += 1;
  }
  return count;
}

function collectMcpFormAnswers(fields) {
  const answers = {};
  for (const [fieldId, field] of fields) {
    if (field.multiple) {
      answers[fieldId] = [...field.control.selectedOptions]
        .filter((option) => option.dataset.omit !== "true")
        .map((option) => option.value);
    } else if (field.select) {
      const selected = [...field.control.selectedOptions][0];
      answers[fieldId] = !selected || selected.dataset.omit === "true"
        ? []
        : [selected.value];
    } else {
      answers[fieldId] = field.control.value === "" ? [] : [field.control.value];
    }
  }
  return answers;
}

function reportMcpFormError(fields, message, result) {
  for (const field of fields.values()) field.control.setCustomValidity?.("");
  message.textContent = result.message;
  message.hidden = false;
  const control = fields.get(result.fieldId)?.control;
  control?.setCustomValidity?.(result.message);
  control?.focus?.();
  control?.reportValidity?.();
}

async function answerInteraction(card, interactionId, action, answers) {
  const controls = card.querySelectorAll("button, input, select");
  controls.forEach((control) => { control.disabled = true; });
  try {
    await request("interaction.answer", { interactionId, action, answers });
  } catch (error) {
    controls.forEach((control) => { control.disabled = false; });
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

function removeInteraction(interactionId) {
  elements.approvalList.querySelector(
    `[data-interaction-id="${CSS.escape(interactionId)}"]`,
  )?.remove();
}

function updateControls() {
  const connected = state.authenticated && state.connectionReady;
  const hasSession = Boolean(state.sessionId);
  const hasText = Boolean(elements.messageInput.value.trim());
  const hasAttachments = readyAttachments().length > 0;
  const uploading = hasUnfinishedUploads();
  const busy = state.running || state.commandBusy;
  const navigationBusy = state.navigationBusy || state.sessionLoading;
  const navigationLocked = state.commandBusy || navigationBusy || uploading;
  const projectHasActiveTask = visibleSessionSummaries().some((session) => session.state === "active");
  elements.projectSelect.disabled = !connected || navigationLocked || state.selectionMode;
  elements.newSessionButton.disabled = !connected || navigationLocked ||
    state.selectionMode || !state.projectId;
  elements.sessionSearchInput.disabled = !connected || navigationBusy ||
    state.selectionMode || !state.projectId;
  elements.selectSessionsButton.disabled = !connected || navigationLocked ||
    projectHasActiveTask ||
    selectableSessions().length === 0;
  elements.selectAllSessionsButton.disabled = !connected || navigationBusy || busy ||
    selectableSessions().length === 0;
  elements.loadMoreSessionsButton.disabled = !connected || navigationBusy;
  elements.sessionViewBackButton.disabled = !connected || navigationBusy;
  elements.archivedSessionsButton.disabled = !connected || navigationBusy;
  elements.trashSessionsButton.disabled = !connected || navigationBusy;
  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    const itemIsActive = item.dataset.state === "active";
    for (const button of item.querySelectorAll("button")) {
      const opensSession = button.classList.contains("session-open");
      const cannotOpen = opensSession && state.sessionView !== "active";
      button.disabled = !connected || navigationLocked || cannotOpen ||
        (!opensSession && (state.running || projectHasActiveTask || itemIsActive));
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
  const controlsDisabled = !connected || !hasSession || busy || navigationBusy || state.selectionMode;
  elements.commandMenuButton.disabled = controlsDisabled;
  elements.modelPickerButton.disabled = controlsDisabled;
  elements.permissionPickerButton.disabled = controlsDisabled;
  if (controlsDisabled) { closeComposerPicker(); slashCommands.close(); }
  if (state.stopping) {
    elements.taskButton.textContent = "停止中";
    elements.taskButton.classList.toggle("primary", false);
    elements.taskButton.classList.toggle("danger", true);
    elements.taskButton.disabled = true;
  } else {
    elements.taskButton.textContent = state.running ? "停止" : "发送";
    elements.taskButton.classList.toggle("primary", !state.running);
    elements.taskButton.classList.toggle("danger", state.running);
    elements.taskButton.disabled = state.running
      ? !connected || !state.controlsTask || navigationBusy
      : !connected || !hasSession || state.commandBusy || uploading || navigationBusy ||
        (!hasText && !hasAttachments);
  }
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
  state.rewindTargetTurnId = null;
  state.rewindText = null;
  state.rewindAttachments = [];
  slashCommands.close();
  elements.historyLoader.hidden = true;
  hideThinking();
  elements.timeline.replaceChildren();
}

function showEmpty(text) {
  clearTimeline();
  elements.emptyState.querySelector("p").textContent = text;
  elements.timeline.append(elements.emptyState);
}

function showSessionLoading(loadState = "loading") {
  const message = loadState === "queued"
    ? "任务正在排队，等待可用 Worker……"
    : loadState === "starting"
    ? "正在启动 Codex 并恢复会话……"
    : loadState === "restoring"
    ? "正在恢复运行中的任务……"
    : "正在载入会话……";
  showEmpty(message);
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

function rewindDraftFromLatestTask(tasks) {
  const latest = tasks.at(-1);
  const targetTurnId = typeof latest?.id === "string" ? latest.id : null;
  if (!targetTurnId || latest?.restoresInput !== true || !Array.isArray(latest.items)) {
    return { targetTurnId, text: null, attachments: [] };
  }
  const userMessage = latest.items.find((item) =>
    item?.type === "message" && item.role === "user"
  );
  const text = typeof userMessage?.text === "string" ? userMessage.text : "";
  // 附件来自后端的结构化字段；正文里看起来像附件行的文字始终只是正文。
  const attachments = publicAttachments(userMessage?.attachments);
  if (!text && attachments.length === 0) {
    return { targetTurnId, text: null, attachments: [] };
  }
  return { targetTurnId, text: text || null, attachments };
}

function restoreComposerText(text) {
  elements.messageInput.value = text;
  persistCurrentComposerDraft();
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

function showNotice(text, options = TEMPORARY_WARNING) {
  return noticeController.show(text, options);
}

function showActionNotice(text, actionLabel, action, options = {}) {
  return showNotice(text, {
    lifetime: "temporary",
    tone: "info",
    durationMs: NOTICE_DURATION_MS.undo,
    ...options,
    action: { label: actionLabel, run: action },
  });
}

function clearNotice(key) {
  return noticeController.clear(key);
}

function commandStatus(status) {
  return status === "completed"
    ? "完成"
    : status === "failed"
    ? "失败"
    : status === "interrupted"
    ? "已停止"
    : status === "declined"
    ? "已拒绝"
    : status === "inProgress" || status === "in_progress" || status === "pending"
    ? "运行中"
    : status || "结束";
}

function formatDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return formatDisplayTime(
    milliseconds,
    resolveDisplayTimeZone(displayedTimezone(), deviceTimeZone()),
  );
}

async function openAppSettings() {
  if (state.appSettingsBusy) return;
  const generation = ++state.appSettingsLoadGeneration;
  discardDisplayTimezoneDraft();
  syncAppSettingsForm();
  setAppSettingsStatus("");
  state.settingsModelsState = "loading";
  state.settingsModelsError = "";
  state.modelDefaultsMessage = "";
  state.settingsPermissionsState = "loading";
  state.settingsPermissionsError = "";
  renderModelDefaults();
  renderPermissionDefaults();
  const settings = loadBackendSettings(generation);
  const models = loadSettingsModels(generation);
  const permissions = loadSettingsPermissions(generation);
  await settings;
  if (generation !== state.appSettingsLoadGeneration) return;
  if (!elements.appSettingsDialog.open) elements.appSettingsDialog.showModal();
  void models;
  void permissions;
}

function closeAppSettings() {
  if (state.appSettingsBusy) return;
  closeFieldInfoPopovers();
  if (elements.appSettingsDialog.open) elements.appSettingsDialog.close();
}

function closeFieldInfoPopovers() {
  for (const popover of elements.appSettingsDialog.querySelectorAll(".field-info-popover")) {
    if (popover.matches(":popover-open")) popover.hidePopover();
  }
}

function syncAppSettingsForm() {
  const prefs = displayedTimezone();
  elements.followDeviceTimezoneInput.checked = prefs.followDevice;
  elements.followDeviceTimezoneInput.disabled = state.appSettingsBusy;
  elements.displayTimezoneCitySelect.value = prefs.cityTimeZone;
  elements.displayTimezoneCitySelect.disabled = prefs.followDevice || state.appSettingsBusy;
}

async function loadBackendSettings(generation) {
  try {
    const data = await request("settings.get");
    if (generation !== state.appSettingsLoadGeneration) return;
    const value = typeof data?.developerInstructions === "string" ? data.developerInstructions : "";
    state.developerInstructions = value;
    state.defaultModel = typeof data?.defaultModel === "string" ? data.defaultModel : null;
    state.defaultReasoningEffort = typeof data?.defaultReasoningEffort === "string"
      ? data.defaultReasoningEffort
      : null;
    state.defaultModelDraft = state.defaultModel;
    state.defaultReasoningEffortDraft = state.defaultReasoningEffort;
    state.defaultPermissions = typeof data?.defaultPermissions === "string"
      ? data.defaultPermissions
      : null;
    state.defaultPermissionsDraft = state.defaultPermissions;
    elements.developerInstructionsInput.value = value;
    renderModelDefaults();
    renderPermissionDefaults();
    setAppSettingsStatus("");
  } catch (error) {
    if (generation !== state.appSettingsLoadGeneration) return;
    setAppSettingsStatus(errorMessage(error), "error");
  }
}

async function loadSettingsModels(generation) {
  try {
    const data = await request("settings.models");
    if (generation !== state.appSettingsLoadGeneration) return;
    if (!Array.isArray(data)) throw new Error("主机返回了无法识别的模型列表。");
    state.settingsModels = data.flatMap((model) => {
      if (
        !model || typeof model.id !== "string" || !model.id ||
        typeof model.displayName !== "string" || !Array.isArray(model.supportedReasoningEfforts)
      ) return [];
      return [{
        id: model.id,
        displayName: model.displayName,
        defaultReasoningEffort: typeof model.defaultReasoningEffort === "string"
          ? model.defaultReasoningEffort
          : "",
        supportedReasoningEfforts: model.supportedReasoningEfforts.flatMap((option) =>
          option && typeof option.reasoningEffort === "string"
            ? [{ reasoningEffort: option.reasoningEffort }]
            : []
        ),
      }];
    });
    state.settingsModelsState = "ready";
    state.settingsModelsError = "";
  } catch (error) {
    if (generation !== state.appSettingsLoadGeneration) return;
    state.settingsModels = [];
    state.settingsModelsState = "error";
    state.settingsModelsError = errorMessage(error);
  }
  renderModelDefaults();
}

function renderModelDefaults() {
  const model = state.defaultModelDraft;
  const effort = state.defaultReasoningEffortDraft;
  const ready = state.settingsModelsState === "ready";
  const selectedModel = ready
    ? state.settingsModels.find((candidate) => candidate.id === model)
    : null;
  const modelOptions = [{ value: "", label: "跟随 Codex 默认" }];
  if (model && !selectedModel) {
    modelOptions.push({
      value: model,
      label: ready ? `${model}（当前不可用）` : `${model}（已保存）`,
    });
  }
  if (ready) {
    modelOptions.push(...state.settingsModels.map((candidate) => ({
      value: candidate.id,
      label: candidate.displayName,
    })));
  }
  replaceSelectOptions(elements.defaultModelSelect, modelOptions, model ?? "");

  const effortOptions = [{
    value: "",
    label: model === null ? "跟随 Codex 默认" : "跟随模型默认",
  }];
  if (model && effort && !selectedModel?.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === effort,
  )) {
    effortOptions.push({
      value: effort,
      label: ready ? `${effort}（当前不可用）` : `${effort}（已保存）`,
    });
  }
  if (selectedModel) {
    effortOptions.push(...selectedModel.supportedReasoningEfforts.map((option) => ({
      value: option.reasoningEffort,
      label: option.reasoningEffort === selectedModel.defaultReasoningEffort
        ? `${option.reasoningEffort}（模型当前默认）`
        : option.reasoningEffort,
    })));
  }
  replaceSelectOptions(elements.defaultReasoningEffortSelect, effortOptions, effort ?? "");

  elements.defaultModelSelect.disabled = state.appSettingsBusy || !ready;
  elements.defaultReasoningEffortSelect.disabled = state.appSettingsBusy ||
    !ready || model === null || !selectedModel;
  elements.modelDefaultsStatus.textContent = state.modelDefaultsMessage ||
    (state.settingsModelsState === "loading"
      ? "正在读取可用模型……"
      : state.settingsModelsState === "error"
      ? `可用模型暂时无法读取：${state.settingsModelsError}`
      : model && !selectedModel
      ? "已保存的模型当前不在可用列表中；保存其他设置不会清除它。"
      : "只影响之后新建的会话；旧会话和会话内的临时选择不变。");
}

async function loadSettingsPermissions(generation) {
  try {
    const data = await request("settings.permissions");
    if (generation !== state.appSettingsLoadGeneration) return;
    if (!Array.isArray(data)) throw new Error("主机返回了无法识别的权限列表。");
    state.settingsPermissions = data.flatMap((profile) =>
      profile && typeof profile.id === "string" && profile.id &&
        typeof profile.label === "string" && profile.allowed === true
        ? [{
          id: profile.id,
          label: profile.label,
          description: typeof profile.description === "string" ? profile.description : "",
        }]
        : []
    );
    state.settingsPermissionsState = "ready";
    state.settingsPermissionsError = "";
  } catch (error) {
    if (generation !== state.appSettingsLoadGeneration) return;
    state.settingsPermissions = [];
    state.settingsPermissionsState = "error";
    state.settingsPermissionsError = errorMessage(error);
  }
  renderPermissionDefaults();
}

function renderPermissionDefaults() {
  const selected = state.defaultPermissionsDraft;
  const ready = state.settingsPermissionsState === "ready";
  const profile = ready
    ? state.settingsPermissions.find((candidate) => candidate.id === selected)
    : null;
  const options = [{ value: "", label: "跟随 Codex 默认" }];
  if (selected && !profile) {
    options.push({
      value: selected,
      label: ready ? `${selected}（当前不可用）` : `${selected}（已保存）`,
    });
  }
  if (ready) {
    options.push(...state.settingsPermissions.map((candidate) => ({
      value: candidate.id,
      label: candidate.label,
    })));
  }
  replaceSelectOptions(elements.defaultPermissionsSelect, options, selected ?? "");
  elements.defaultPermissionsSelect.disabled = state.appSettingsBusy || !ready;
  elements.defaultPermissionsStatus.textContent = state.settingsPermissionsState === "loading"
    ? "正在读取可用权限……"
    : state.settingsPermissionsState === "error"
    ? `可用权限暂时无法读取：${state.settingsPermissionsError}`
    : selected && !profile
    ? "已保存的权限当前不可用；保存其他设置不会清除它。"
    : profile?.description || "不指定权限，新会话按这台主机的 Codex 配置。";
}

function replaceSelectOptions(select, options, selectedValue) {
  const nodes = options.map(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  });
  select.replaceChildren(...nodes);
  select.value = selectedValue;
}

async function saveAppSettings() {
  if (state.appSettingsBusy) return;
  state.appSettingsBusy = true;
  setAppSettingsStatus("正在保存……");
  updateAppSettingsControls();
  try {
    const data = await request("settings.update", {
      developerInstructions: elements.developerInstructionsInput.value,
      defaultModel: state.defaultModelDraft,
      defaultReasoningEffort: state.defaultReasoningEffortDraft,
      defaultPermissions: state.defaultPermissionsDraft,
    });
    const value = typeof data?.developerInstructions === "string" ? data.developerInstructions : "";
    state.developerInstructions = value;
    state.defaultModel = typeof data?.defaultModel === "string" ? data.defaultModel : null;
    state.defaultReasoningEffort = typeof data?.defaultReasoningEffort === "string"
      ? data.defaultReasoningEffort
      : null;
    state.defaultModelDraft = state.defaultModel;
    state.defaultReasoningEffortDraft = state.defaultReasoningEffort;
    state.defaultPermissions = typeof data?.defaultPermissions === "string"
      ? data.defaultPermissions
      : null;
    state.defaultPermissionsDraft = state.defaultPermissions;
    elements.developerInstructionsInput.value = value;
    commitDisplayTimezoneDraft();
    elements.appSettingsDialog.close();
  } catch (error) {
    setAppSettingsStatus(errorMessage(error), "error");
  } finally {
    state.appSettingsBusy = false;
    updateAppSettingsControls();
  }
}

function setAppSettingsStatus(text, kind = "") {
  elements.appSettingsStatus.textContent = text;
  if (kind) elements.appSettingsStatus.dataset.kind = kind;
  else delete elements.appSettingsStatus.dataset.kind;
}

function updateAppSettingsControls() {
  const disabled = state.appSettingsBusy;
  elements.developerInstructionsInput.disabled = disabled;
  elements.developerInstructionsInfoButton.disabled = disabled;
  elements.modelDefaultsInfoButton.disabled = disabled;
  elements.appSettingsCancelButton.disabled = disabled;
  elements.appSettingsCloseButton.disabled = disabled;
  elements.appSettingsSaveButton.disabled = disabled;
  syncAppSettingsForm();
  renderModelDefaults();
  renderPermissionDefaults();
}

function displayedTimezone() {
  return state.displayTimezoneDraft ?? state.displayTimezone;
}

/** 对话框里改时区只预览；随“保存”写入本地存储，取消、关闭或 Escape 时丢弃。 */
function previewDisplayTimezonePreference() {
  const next = normalizeDisplayTimezonePreference({
    followDevice: elements.followDeviceTimezoneInput.checked,
    cityTimeZone: elements.displayTimezoneCitySelect.value,
  });
  const saved = state.displayTimezone;
  state.displayTimezoneDraft = next.followDevice === saved.followDevice &&
      next.cityTimeZone === saved.cityTimeZone
    ? null
    : next;
  syncAppSettingsForm();
  refreshDisplayedTimes();
}

function commitDisplayTimezoneDraft() {
  if (state.displayTimezoneDraft === null) return;
  state.displayTimezone = saveDisplayTimezonePreference(state.displayTimezoneDraft);
  state.displayTimezoneDraft = null;
  syncAppSettingsForm();
  refreshDisplayedTimes();
}

function discardDisplayTimezoneDraft() {
  if (state.displayTimezoneDraft === null) return;
  state.displayTimezoneDraft = null;
  syncAppSettingsForm();
  refreshDisplayedTimes();
}

/** 另一个标签页保存了时区：更新已保存值；本页正在预览的未保存改动保持不动。 */
function applyStoredDisplayTimezone() {
  state.displayTimezone = loadDisplayTimezonePreference();
  if (state.displayTimezoneDraft !== null) return;
  syncAppSettingsForm();
  refreshDisplayedTimes();
}

function refreshDisplayedTimes() {
  renderSessionList();
  renderSessionMetrics();
  for (const text of elements.timeline.querySelectorAll("[data-display-timestamp]")) {
    const stamp = Number(text.dataset.displayTimestamp);
    text.textContent = `${text.dataset.displayBefore ?? ""}${formatDate(stamp)}${text.dataset.displayAfter ?? ""}`;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "请求失败。";
}

function readRecoveryState() {
  try {
    const recovery = recoveryStore.load();
    if (recoveryStore.persisted && !recoveryStore.lastError) clearRecoveryProblem();
    else reportRecoveryProblem(recoveryStore.lastError);
    return recovery;
  } catch (error) {
    reportRecoveryProblem(error);
    return null;
  }
}

function updateRecoveryState(mutator, options = {}) {
  try {
    const result = recoveryStore.update(mutator, options);
    if (result.committed && result.persisted) clearRecoveryProblem();
    else reportRecoveryProblem(recoveryStore.lastError);
    return result;
  } catch (error) {
    reportRecoveryProblem(error);
    return null;
  }
}

function ensureRecoveryPersisted() {
  if (!readRecoveryState()) return false;
  if (recoveryStore.ensurePersisted()) {
    clearRecoveryProblem();
    return true;
  }
  reportRecoveryProblem(recoveryStore.lastError);
  return false;
}

function reportRecoveryProblem(error) {
  const problem = error instanceof RecoveryStateError
    ? error
    : new RecoveryStateError("recovery_unavailable", "浏览器无法读写恢复记录。", {
      cause: error,
    });
  const signature = `${problem.code}:${problem.key || "unknown"}`;
  if (signature === recoveryProblemSignature) return;
  recoveryProblemSignature = signature;
  const options = {
    lifetime: "persistent",
    tone: "error",
    key: RECOVERY_NOTICE_KEY,
    force: true,
  };
  if (problem.code === "recovery_corrupt" && typeof problem.raw === "string") {
    options.action = {
      label: "复制原始记录",
      run: async () => {
        if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不能复制恢复记录。");
        await navigator.clipboard.writeText(`${problem.key || RECOVERY_KEY}\n${problem.raw}`);
        showNotice("原始恢复记录已复制；应用没有覆盖它。", TEMPORARY_INFO);
      },
    };
  }
  showNotice(problem.code === "recovery_corrupt"
    ? "本地恢复记录已损坏；应用没有覆盖原始内容，也不会自动重试其中的操作。"
    : "本地恢复存储当前不可用；草稿只在此页面暂存，新的发送和回退不会开始。", options);
}

function clearRecoveryProblem() {
  recoveryProblemSignature = null;
  clearNotice(RECOVERY_NOTICE_KEY);
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
    toggleAll() { showNotice("命令菜单当前不可用，请刷新页面。", TEMPORARY_WARNING); },
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


let metricsRequestPending = false;
let metricsRefreshQueued = false;
async function refreshSessionMetrics() {
  if (!state.authenticated || !state.projectId || !state.sessionId) return;
  metricsRefreshQueued = true;
  if (document.hidden || metricsRequestPending) return;
  metricsRefreshQueued = false;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  const generation = state.generation;
  metricsRequestPending = true;
  try {
    const data = await request("session.metrics", { projectId, sessionId });
    if (state.projectId !== projectId || state.sessionId !== sessionId ||
        state.generation !== generation) return;
    state.metrics = data.sessionId === sessionId ? data.metrics : null;
    const session = findSessionSummary(sessionId);
    if (
      session &&
      typeof state.metrics?.lastReplyAt === "number" &&
      Number.isFinite(state.metrics.lastReplyAt)
    ) {
      session.lastReplyAt = state.metrics.lastReplyAt;
      renderSessionList();
    }
  } catch {
    if (state.projectId !== projectId || state.sessionId !== sessionId ||
        state.generation !== generation) return;
    state.metrics = null;
  } finally {
    metricsRequestPending = false;
    // 切换会话或 Worker 结束若发生在查询期间，完成后补取最新数据。
    if (metricsRefreshQueued) void refreshSessionMetrics();
  }
  renderSessionMetrics();
}

function renderSessionMetrics() {
  elements.sessionMetrics.hidden = !state.sessionId;
  if (!state.sessionId) { elements.sessionMetrics.textContent = ""; return; }
  const metrics = state.metrics;
  const parts = [metrics?.context
    ? `上下文约 ${metrics.context.percentage.toFixed(1)}%`
    : "上下文等待更新"];
  if (metrics?.windows?.length) {
    for (const quota of metrics.windows) {
      const left = typeof quota.remainingPercent === "number"
        ? `${quota.remainingPercent.toFixed(1)}%` : "未知";
      const reset = formatDate(quota.resetsAt);
      const label = quota.label.replace(/^codex（(.+)）$/i, "$1");
      parts.push(`${label}剩余 ${left}${reset ? `，${reset} 重置` : ""}`);
    }
  } else parts.push("套餐额度不可用");
  parts.push(metrics?.lastReplyAt
    ? `最后回复时间 ${formatDate(metrics.lastReplyAt)}` : "最后回复时间不可用");
  elements.sessionMetrics.replaceChildren();
  parts.forEach((text, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "session-metrics-separator";
      separator.textContent = "|";
      separator.setAttribute("aria-hidden", "true");
      elements.sessionMetrics.append(separator);
    }
    elements.sessionMetrics.append(document.createTextNode(text));
  });
  elements.sessionMetrics.title = "上下文按最近一次调用的 Token 用量估算；额度属于账号。历史回复时间按该轮完成时间显示。";
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshSessionMetrics();
});


// 以右侧顶栏的实际高度同步桌面侧栏首行，跟随信息条、字体和窗口变化。
const conversationHeader = document.querySelector(".app-header");
const headerHeightObserver = new ResizeObserver(() => {
  const height = conversationHeader.getBoundingClientRect().height;
  if (height > 0) {
    elements.appView.style.setProperty("--conversation-header-height", `${height}px`);
  }
});
headerHeightObserver.observe(conversationHeader);

// 两个选择入口共用菜单；数据和变更都沿用现有命令接口。
function closeComposerPicker() {
  elements.composerPickerMenu.hidden = true;
  // 关一次就作废一代，正在途中的打开请求回来时按这个丢弃。
  state.pickerGeneration += 1;
  for (const kind of ["model", "permission"]) {
    composerPickers[kind].button.setAttribute("aria-expanded", "false");
  }
}

async function refreshPickerLabels() {
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  if (!projectId || !sessionId || !state.authenticated) return;
  await Promise.all(["model", "permissions"].map(async command => {
    try {
      const data = await request("command.options", { projectId, sessionId, command });
      if (state.projectId !== projectId || state.sessionId !== sessionId) return;
      const selected = data.items?.find(item => item.selected);
      const label = selected?.label || "默认";
      const kind = command === "model" ? "model" : "permission";
      composerPickers[kind].label.textContent = label;
      composerPickers[kind].button.title = label;
    } catch { /* 会话忙碌时后端可能拒绝查询，下次打开时重新读取。 */ }
  }));
}

/**
 * 菜单打开时该把焦点放在哪个按钮上。
 *
 * 不能写成一个逗号分隔的选择器：那样拿到的是文档顺序里第一个命中任一条的
 * 元素，而不是优先命中前一条的。打勾那项永远排在第一个可点按钮后面（有
 * “‹ 返回”时更是排在它后面），于是焦点永远落不到打勾那项上。
 */
function pickerFocusTarget(menu) {
  return menu.querySelector('button[aria-selected="true"]:not(:disabled)') ??
    menu.querySelector("button.composer-picker-option:not(:disabled)") ??
    menu.querySelector("button:not(:disabled)");
}

function renderComposerPicker(title, items, onSelect, onBack) {
  const menu = elements.composerPickerMenu;
  const heading = document.createElement("div");
  heading.className = "composer-picker-heading";
  if (onBack) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "composer-picker-back";
    back.textContent = "‹ 返回";
    back.addEventListener("click", onBack);
    heading.append(back);
  }
  const label = document.createElement("strong");
  label.textContent = title;
  heading.append(label);
  menu.replaceChildren(heading);
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-picker-option";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(item.selected === true));
    button.disabled = item.disabled === true;
    const name = document.createElement("strong");
    name.textContent = item.label || item.id;
    const detail = document.createElement("span");
    detail.className = "composer-picker-description";
    detail.textContent = item.description || "";
    button.append(name, detail);
    button.addEventListener("click", () => onSelect(item));
    menu.append(button);
  }
  menu.hidden = false;
  pickerFocusTarget(menu)?.focus();
}

async function openComposerPicker(command) {
  const kind = command === "model" ? "model" : "permission";
  const trigger = composerPickers[kind].button;
  if (trigger.disabled) return;
  const wasOpen = trigger.getAttribute("aria-expanded") === "true";
  closeComposerPicker();
  slashCommands.close();
  if (wasOpen) return;
  trigger.setAttribute("aria-expanded", "true");
  const pickerGeneration = state.pickerGeneration;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  if (!projectId || !sessionId) return;
  try {
    const data = await request("command.options", { projectId, sessionId, command });
    if (state.projectId !== projectId || state.sessionId !== sessionId ||
        state.pickerGeneration !== pickerGeneration) return;
    const items = data.items || [];
    const selected = items.find(item => item.selected);
    composerPickers[kind].label.textContent = selected?.label || "默认";
    const choose = async (item, argument = null) => {
      if (state.projectId !== projectId || state.sessionId !== sessionId || trigger.disabled) return;
      if (item.danger && !window.confirm("完全访问会让 Codex 不受项目沙箱限制地操作主机。确定只为当前会话选择吗？")) return;
      closeComposerPicker();
      state.commandBusy = true;
      updateControls();
      try {
        const result = await request("command.run", {
          projectId,
          sessionId,
          command,
          option: item.id,
          argument,
        });
        if (state.projectId === projectId && state.sessionId === sessionId) addCommandResult(result);
        await refreshPickerLabels();
      } catch (error) { showNotice(errorMessage(error), TEMPORARY_ERROR); }
      finally { state.commandBusy = false; updateControls(); trigger.focus(); }
    };
    const root = () => {
      const rows = [...items];
      if (command === "model") {
        rows.push({
          id: "__effort",
          label: "Effort ›",
          description: selected?.items?.find(item => item.selected)?.label ||
            "选择当前模型的思考强度",
          disabled: !selected?.items?.length,
        });
      }
      renderComposerPicker(command === "model" ? "选择模型" : "权限模式", rows, item => {
        if (item.id === "__effort") {
          renderComposerPicker("Effort", selected.items, effort => void choose(selected, effort.id), root);
        } else { void choose(item); }
      });
    };
    root();
  } catch (error) {
    if (state.pickerGeneration !== pickerGeneration) return;
    closeComposerPicker();
    showNotice(errorMessage(error), TEMPORARY_ERROR);
  }
}

for (const [kind, command] of [["model", "model"], ["permission", "permissions"]]) {
  composerPickers[kind].button.addEventListener("click", () => void openComposerPicker(command));
}

document.addEventListener("click", event => {
  const path = event.composedPath();
  const inside = selector => path.some(node => node instanceof Element && node.matches(selector));
  if (!inside(".composer-picker-menu, .composer-select-button")) closeComposerPicker();
  if (!inside("#slash-menu, #command-menu-button, #message-input")) slashCommands.close();
});
document.addEventListener("keydown", event => {
  const menu = elements.composerPickerMenu;
  if (menu.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    const trigger = document.querySelector('.composer-select-button[aria-expanded="true"]');
    closeComposerPicker();
    trigger?.focus();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
      ? buttons.length - 1
      : (index + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
});

function openRenameDialog(initialTitleOrSession) {
  const fromSession = initialTitleOrSession && typeof initialTitleOrSession === "object"
    ? initialTitleOrSession
    : null;
  const initialTitle = typeof initialTitleOrSession === "string" ? initialTitleOrSession : null;
  const dialog = elements.renameDialog;
  const input = elements.renameInput;
  if (fromSession) {
    dialog.dataset.sessionId = fromSession.id;
    dialog.dataset.projectId = fromSession.projectId || "";
    input.value = fromSession.title || "新会话";
  } else {
    if (!state.sessionId || state.commandBusy || state.running) return;
    dialog.dataset.sessionId = state.sessionId;
    dialog.dataset.projectId = state.projectId || "";
    input.value = initialTitle ?? state.sessionTitle ?? "";
  }
  elements.renameStatus.textContent = "";
  closeComposerPicker();
  if (!dialog.open) dialog.showModal();
  input.focus();
  input.select();
}
elements.renameCancelButton.addEventListener("click", () => elements.renameDialog.close());
elements.renameForm.addEventListener("submit", async event => {
  event.preventDefault();
  const dialog = elements.renameDialog;
  const status = elements.renameStatus;
  const title = elements.renameInput.value.trim();
  if (!title) { status.textContent = "会话名称不能为空。"; return; }
  const sessionId = dialog.dataset.sessionId;
  const projectId = dialog.dataset.projectId || state.projectId;
  if (!sessionId || !projectId) {
    status.textContent = "找不到要改名的会话。";
    return;
  }
  const session = findSessionSummary(sessionId);
  const displayed = session?.title || (sessionId === state.sessionId ? state.sessionTitle : "") || "";
  if (title === displayed) {
    dialog.close();
    return;
  }
  elements.renameSaveButton.disabled = true;
  try {
    const data = await request("session.rename", { projectId, sessionId, title });
    if (data?.session) {
      upsertSession(data.session);
      if (data.session.id === state.sessionId) {
        state.sessionTitle = data.session.title;
        updateConversationTitle();
      }
      renderSessionList();
    }
    dialog.close();
  } catch (error) {
    status.textContent = errorMessage(error);
  } finally {
    elements.renameSaveButton.disabled = false;
    updateControls();
  }
});
