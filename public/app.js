import { renderMarkdown, sanitizeHref } from "./markdown.js";
import { createConfirmDialog } from "./confirm-dialog.js";
import { createNoticeController } from "./notice.js";
import { createSelectionBar, trashRemainingText } from "./selection-bar.js";
import {
  DISPLAY_TIMEZONE_KEY,
  deviceTimeZone,
  formatDisplayTime,
  loadDisplayTimezonePreference,
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

/** Interface text from i18n.js, which loads in <head> before this module. */
const t = window.codexRemoteI18n ? window.codexRemoteI18n.t : (key) => key;

/** Text the backend sent, as final text or { key, params }; see codexRemoteI18n.localize. */
const localize = window.codexRemoteI18n
  ? window.codexRemoteI18n.localize
  : (value, fallback = "") => typeof value === "string" ? value : fallback;

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
const SESSION_SELECTION_VIEWS = Object.freeze({
  active: { actions: [
    { id: "archive", labelKey: "selection.archive", doneKey: "selection.doneArchive", icon: "archive" },
    { id: "trash-active", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
  ] },
  archived: { actions: [
    { id: "unarchive", labelKey: "selection.unarchive", doneKey: "selection.doneUnarchive", icon: "unarchive" },
    { id: "trash-archived", labelKey: "common.delete", doneKey: "selection.doneTrash", icon: "delete", danger: true },
  ] },
  trash: { actions: [
    { id: "restore-trash", labelKey: "selection.restore", doneKey: "selection.doneRestore", icon: "restore" },
    {
      id: "delete-trash",
      labelKey: "selection.purge",
      doneKey: "selection.donePurge",
      icon: "purge",
      danger: true,
      permanent: true,
    },
  ] },
});

function measureScrollbarWidth() {
  const probe = document.createElement("div");
  probe.className = "scrollbar-measure";
  probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll;visibility:hidden;";
  document.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

document.documentElement.style.setProperty("--scrollbar-width", `${measureScrollbarWidth()}px`);

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
  modelDefaultsSaveButton: byId("model-defaults-save-button"),
  modelDefaultsSaveStatus: byId("model-defaults-save-status"),
  developerInstructionsSaveButton: byId("developer-instructions-save-button"),
  developerInstructionsSaveStatus: byId("developer-instructions-save-status"),
  themeSetting: byId("theme-setting"),
  themeOptions: byId("theme-options"),
  languageSetting: byId("language-setting"),
  languageOptions: byId("language-options"),
  defaultModelSelect: byId("default-model-select"),
  defaultReasoningEffortSelect: byId("default-reasoning-effort-select"),
  defaultPermissionsSelect: byId("default-permissions-select"),
  defaultPermissionsStatus: byId("default-permissions-status"),
  modelDefaultsInfoButton: byId("model-defaults-info-button"),
  modelDefaultsStatus: byId("model-defaults-status"),
  developerInstructionsInput: byId("developer-instructions-input"),
  developerInstructionsInfoButton: byId("developer-instructions-info-button"),
  displayTimezoneSelect: byId("display-timezone-select"),
  sidebarBackdrop: byId("sidebar-backdrop"),
  projectSelect: byId("project-select"),
  newSessionButton: byId("new-session-button"),
  sessionSearchInput: byId("session-search-input"),
  sessionViewBackButton: byId("session-view-back-button"),
  sessionViewTitle: byId("session-view-title"),
  selectSessionsButton: byId("select-sessions-button"),
  selectionHeading: byId("selection-heading"),
  sessionList: byId("session-list"),
  loadMoreSessionsButton: byId("load-more-sessions-button"),
  archivedSessionsButton: byId("archived-sessions-button"),
  trashSessionsButton: byId("trash-sessions-button"),
  appAlertDialog: byId("app-alert-dialog"),
  appAlertTitle: byId("app-alert-title"),
  appAlertMessage: byId("app-alert-message"),
  confirmDialog: byId("confirm-dialog"),
  confirmDialogTitle: byId("confirm-dialog-title"),
  confirmDialogMessage: byId("confirm-dialog-message"),
  confirmDialogAcceptButton: byId("confirm-dialog-accept-button"),
  confirmDialogCancelButton: byId("confirm-dialog-cancel-button"),
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

// Both selection entry points share one structure; keep the registry flat and resolve elements here by kind.
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
  sidebarCollapsed: stateGet(SIDEBAR_COLLAPSED_KEY) === "1",
  /** Display time zone saved in this browser; the settings select writes it on change. */
  displayTimezone: loadDisplayTimezonePreference(),
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
  appSettingsLoadState: "idle",
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
const confirmDialogController = createConfirmDialog({
  dialog: elements.confirmDialog,
  titleElement: elements.confirmDialogTitle,
  messageElement: elements.confirmDialogMessage,
  acceptButton: elements.confirmDialogAcceptButton,
  cancelButton: elements.confirmDialogCancelButton,
});
const selectionBar = createSelectionBar({
  container: elements.selectionHeading,
  views: SESSION_SELECTION_VIEWS,
  initialView: state.sessionView,
  getId: (session) => session.id,
  getTitle: (session) => session.title,
  isSelectable: sessionSelectable,
  isPinned: (session) => Boolean(session.marked),
  executeAction: executeSessionSelectionAction,
  refreshItems: () => loadSessions(),
  confirm: (message, options) => confirmDialogController.show(message, options),
  notify: (message, tone) => showNotice(
    message,
    tone === "error" ? TEMPORARY_ERROR : TEMPORARY_INFO,
  ),
  errorMessage,
  onSelectionChange: renderSessionList,
  onBusyChange: setNavigationBusy,
  onBack: () => setSessionView("active"),
});
elements.appView.dataset.sidebarCollapsed = String(state.sidebarCollapsed);
syncSidebarState();
syncAppSettingsForm();
labelScriptedText();
const slashCommandOptions = {
  input: elements.messageInput,
  element: elements.slashMenu,
  button: elements.commandMenuButton,
  request: requestSlashCommand,
  onResult: (result) => { addCommandResult(result); void refreshPickerLabels(); },
  onRename: openRenameDialog,
  actions: [
    { get label() { return t("composer.addAttachment"); }, get description() { return t("composer.addAttachmentHint"); }, disabled: () => state.pendingAttachments.length >= MAX_MESSAGE_ATTACHMENTS, onSelect: () => elements.attachmentInput.click() },
    { get label() { return t("rename.title"); }, get description() { return t("composer.renameHint"); }, onSelect: () => openRenameDialog() },
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
    setLoginStatus(t("login.tokenMissing"), "error");
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
  showEmpty("empty.chooseSession");
  void loadSessions();
});

elements.openSidebarButton.addEventListener("click", openSidebar);
elements.collapseSidebarButton.addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
elements.appSettingsButton.addEventListener("click", () => {
  void openAppSettings();
});
elements.appSettingsCloseButton.addEventListener("click", closeAppSettings);
elements.themeOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme-choice]");
  if (!button || !window.codexRemoteTheme) return;
  window.codexRemoteTheme.set(button.dataset.themeChoice);
  renderThemeChoice();
});
elements.languageOptions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-language-choice]");
  if (button && window.codexRemoteI18n) window.codexRemoteI18n.set(button.dataset.languageChoice);
});
window.addEventListener("codex-remote-languagechange", () => {
  renderLanguageChoice();
  relabelInterface();
});
elements.appSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
});
elements.modelDefaultsSaveButton.addEventListener("click", () => void saveAppSettings("defaults"));
elements.developerInstructionsSaveButton.addEventListener("click", () => void saveAppSettings("instructions"));
elements.appSettingsDialog.addEventListener("cancel", (event) => {
  if (state.appSettingsBusy) event.preventDefault();
});
elements.appSettingsDialog.addEventListener("close", () => {
  closeFieldInfoPopovers();
  setAllAppSettingsStatuses("");
});
elements.displayTimezoneSelect.addEventListener("change", selectDisplayTimezone);
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
    state.modelDefaultsMessage = "settings.effortReset";
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
  selectionBar.setManualSelection(true);
});

elements.loadMoreSessionsButton.addEventListener("click", () => {
  void loadSessions({ append: true });
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

function canAddAttachments() {
  return !elements.commandMenuButton.disabled;
}

function clearAttachmentDrag() {
  elements.composer.classList.remove("file-drag-over");
  elements.composer.removeAttribute("data-drop-label");
}

function isFileDrag(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

for (const name of ["dragenter", "dragover"]) {
  elements.composer.addEventListener(name, (event) => {
    if (!isFileDrag(event) || !canAddAttachments()) {
      clearAttachmentDrag();
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    elements.composer.classList.add("file-drag-over");
    elements.composer.setAttribute("data-drop-label", t("attachment.dropHere"));
  });
}
elements.composer.addEventListener("dragleave", (event) => {
  if (!elements.composer.contains(event.relatedTarget)) clearAttachmentDrag();
});
elements.composer.addEventListener("drop", (event) => {
  event.preventDefault();
  clearAttachmentDrag();
  if (!canAddAttachments()) return;
  const transfer = event.dataTransfer;
  const files = [];
  let folders = false;
  let unsupported = false;
  // Entry access is synchronous: browsers protect the drag data after this event.
  if (transfer?.items?.length) {
    for (const item of transfer.items) {
      if (item.kind !== "file") {
        unsupported = true;
        continue;
      }
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        folders = true;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } else {
    files.push(...(transfer?.files ?? []));
    unsupported = files.length === 0;
  }
  const notices = [];
  if (folders) notices.push(t("attachment.noFolders"));
  if (unsupported && files.length === 0 && !folders) notices.push(t("attachment.noWebContent"));
  void uploadFiles(files, notices);
});

// A drop anywhere else must never navigate away from the conversation.
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!canAddAttachments()) clearAttachmentDrag();
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  clearAttachmentDrag();
});
document.addEventListener("dragend", clearAttachmentDrag);
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) clearAttachmentDrag();
});
window.addEventListener("blur", clearAttachmentDrag);

elements.messageInput.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length || !canAddAttachments()) return;
  event.preventDefault();
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  void uploadFiles(files.map((file, index) => {
    if (!/^image\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name) || !file.type.startsWith("image/")) return file;
    const extension = file.name.split(".").pop().toLowerCase();
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return new File([file], `screenshot-${stamp}${suffix}.${extension}`, { type: file.type, lastModified: file.lastModified });
  }));
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
setLoginStatus(t("login.connecting"), "progress");
void connect();

async function connect(token) {
  const generation = ++state.generation;
  state.connectionReady = false;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  rejectPending(new Error(t("connection.reestablished")));

  if (state.socket) {
    state.socket.onclose = null;
    state.socket.close();
  }

  state.authenticated = false;
  updateControls();
  elements.connectButton.disabled = true;
  setLoginStatus(t("login.connecting"), "progress");
  setConnectionStatus("connecting", "connection.connecting");

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
      throw new Error(t("login.noResponse"));
    }
    if (generation !== state.generation) return;
    if (response.status === 401) {
      state.reconnectAllowed = false;
      elements.connectButton.disabled = false;
      showLogin();
      setLoginStatus(token ? t("login.tokenInvalid") : t("login.required"), token ? "error" : null);
      return;
    }
    if (!response.ok) throw new Error(t("login.unavailable"));
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
    setLoginStatus(errorMessage(error), "error");
    elements.connectButton.disabled = false;
    setConnectionStatus("disconnected", "connection.disconnected");
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
      setLoginStatus("");
      elements.connectButton.disabled = false;
      showApp();
      setConnectionStatus("connecting", "connection.restoring");
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
          // Another device moved the session during restoration: the page has returned to the session list,
          // but the connection itself is healthy.
          if (openGeneration === state.openGeneration) throw error;
        } finally {
          finishOpenIntent(openGeneration);
        }
        if (generation !== state.generation || socket.readyState !== WebSocket.OPEN) return;
        // Ignore a late result when the open intent is invalidated, but allow the connection to finish restoring.
        if (openGeneration === state.openGeneration) {
          if (projectId !== state.projectId || sessionId !== state.sessionId) return;
          applySessionResumeResult(opened, sessionId, {
            preserveAttachments: true,
            retryDeferred: false,
          });
          if (opened.notice) showNotice(localize(opened.notice), {
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
      setConnectionStatus("connected", "connection.connected");
      clearNotice(CONNECTION_NOTICE_KEY);
      updateControls();
    } catch (error) {
      if (generation !== state.generation) return;
      const message = errorMessage(error);
      setLoginStatus(message, "error");
      elements.connectButton.disabled = false;
      showNotice(t("connection.retrying", { message }), {
        lifetime: "state",
        tone: "warning",
        key: CONNECTION_NOTICE_KEY,
      });
      socket.close();
    }
  });

  socket.addEventListener("error", () => {
    if (generation === state.generation && !state.authenticated) {
      setLoginStatus(t("login.hostUnreachable"), "error");
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
    rejectPending(new Error(t("connection.lost")));
    elements.approvalList.replaceChildren();
    setConnectionStatus("disconnected", "connection.disconnected");
    updateControls();

    if (state.reconnectAllowed) {
      if (!elements.appView.hidden) {
        showNotice(t("connection.interrupted"), {
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
    showNotice(t("connection.badMessage"), TEMPORARY_ERROR);
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
      const error = new Error(localize(message.error?.text, message.error?.message || t("request.failed")));
      error.code = message.error?.code;
      pending.reject(error);
    }
    return;
  }

  if (message.type === "error") {
    showNotice(localize(message.error?.text, message.error?.message || t("connection.error")), TEMPORARY_ERROR);
    return;
  }

  if (message.type === "event" && message.event) {
    handleServerEvent(message.event);
  }
}

function request(type, payload = {}) {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error(t("connection.notConnected")));
  }

  const requestId = `${Date.now().toString(36)}-${++state.requestNumber}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = state.pendingRequests.get(requestId);
      if (!pending) return;
      state.pendingRequests.delete(requestId);
      const error = new Error(t("request.timeout"));
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
  // A successful list response is the backend's authoritative allowlist; a scan failure rejects the request
  // itself and enters reconnection. If the current session's project is absent, detach while preserving its
  // draft under the original session instead of keeping it around for repeated reconnection attempts.
  if (state.sessionId && !savedAvailable) {
    invalidateOpenIntent();
    resetCurrentSession();
    showNotice(t("session.projectGone"), TEMPORARY_WARNING);
  }

  if (projects.length === 0) {
    state.projectId = null;
    state.sessions = [];
    state.markedSessions = [];
    state.sessionCursor = null;
    state.sessionLoadError = null;
    renderSessionList();
    showEmpty("empty.noProjects");
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
    showEmpty("empty.chooseSession");
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
      // The list has already been cleared. Render failures as errors rather than authoritative empty-state copy
      // such as “no sessions yet”.
      state.sessionLoadError = errorMessage(error);
    }
  } finally {
    if (generation === state.sessionLoadGeneration) {
      state.sessionLoading = false;
      renderSessionList();
    }
    updateControls();
  }
}

/** Starts one create or open operation from the page, invalidating any earlier open still in flight. */
function beginOpenIntent(projectId, sessionId) {
  const generation = ++state.openGeneration;
  state.openIntent = { generation, projectId, sessionId };
  return generation;
}

function invalidateOpenIntent() {
  state.openGeneration += 1;
  state.openIntent = null;
}

/** Returns true when no newer open is in flight, allowing the caller to release the navigation lock. */
function finishOpenIntent(generation) {
  if (state.openIntent && state.openIntent.generation !== generation) return false;
  state.openIntent = null;
  return true;
}

/**
 * Another device archived, trashed, or deleted the target being opened: invalidate this open and return
 * to “no session selected” without waiting for a late result. When the target has not yet attached on the backend,
 * the event has no closedSessionId, so only this path can finish the transition.
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
  showEmpty("empty.sessionRemoved");
  return true;
}

async function startSession() {
  if (!state.projectId) return;
  if (state.sessionView !== "active") setSessionView("active", false);
  else if (selectionBar.isSelecting()) {
    selectionBar.setView("active");
    renderSessionList();
  }
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
    if (opened.notice) showNotice(localize(opened.notice), {
      lifetime: "persistent",
      tone: "warning",
      key: "host-memory-degraded",
    });
    if (opened.settingsNotice) showNotice(localize(opened.settingsNotice), TEMPORARY_WARNING);
  } catch (error) {
    if (generation !== state.openGeneration) return;
    showNotice(errorMessage(error), TEMPORARY_ERROR);
    // The old session has already been removed and cannot be restored. Rather than leave the composer
    // pointing at an invisible session, return to “no session selected”.
    resetCurrentSession();
    showEmpty("empty.chooseSession");
  } finally {
    if (finishOpenIntent(generation)) setNavigationBusy(false);
    updateControls();
  }
}

async function resumeSession(sessionId) {
  const selected = findSessionSummary(sessionId);
  if (selected && !directoryAvailable(selected.projectId)) {
    showAlert(t("session.directoryGone"), t("session.cannotOpen"));
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
  // Remove the old session content during a switch. If retained, stop, send, and load-earlier remain clickable,
  // but those requests target whichever session the connection currently has open. If the switch arrives first,
  // they would affect the new session.
  if (switching) showSessionLoading();
  try {
    const opened = await request("session.resume", {
      projectId: state.projectId,
      sessionId,
      acceptLoadingStates: true,
    });
    // While waiting, another device may move the target or the page may acquire a newer navigation intent.
    // A late result must not render this session back onto the page.
    if (generation !== state.openGeneration) return;
    applySessionResumeResult(opened, sessionId);
    if (opened.notice) showNotice(localize(opened.notice), {
      lifetime: "persistent",
      tone: "warning",
      key: "host-memory-degraded",
    });
  } catch (error) {
    if (generation !== state.openGeneration) return;
    showNotice(errorMessage(error), TEMPORARY_ERROR);
    if (switching) {
      resetCurrentSession();
      showEmpty("empty.chooseSession");
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
    (previousSessionId === sessionId ? state.sessionTitle : "");
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
  state.sessionTitle = opened.session.title || "";
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
    showNotice(t("task.stillEnding"), {
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
  selectionBar.setView(view);
  state.sessions = [];
  state.markedSessions = [];
  state.sessionCursor = null;
  state.sessionLoadError = null;
  renderSessionViewTitle();
  const activeView = view === "active";
  elements.sessionViewBackButton.hidden = activeView;
  elements.archivedSessionsButton.hidden = !activeView;
  elements.trashSessionsButton.hidden = !activeView;
  renderSessionList();
  if (load) void loadSessions();
}

function renderSessionViewTitle() {
  elements.sessionViewTitle.textContent = t(state.sessionView === "active"
    ? "sidebar.recent"
    : state.sessionView === "archived"
    ? "sidebar.archived"
    : "sidebar.trash");
}

function renderSessionList() {
  // The list is temporarily cleared when refresh begins. Reconcile after this refresh settles instead of
  // prematurely discarding a selection that still exists.
  if (!state.sessionLoading) selectionBar.reconcile(visibleSessionSummaries());
  elements.sessionViewTitle.parentElement.hidden = selectionBar.isSelecting();
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
    loading.textContent = t("sessions.loading");
    elements.sessionList.append(loading);
  } else if (state.sessionLoadError && listEmpty) {
    elements.sessionList.append(createSessionLoadError(state.sessionLoadError));
  } else if (state.sessions.length === 0) {
    if (marked.length === 0) {
      const empty = document.createElement("p");
      empty.className = "session-list-empty";
      const searching = Boolean(elements.sessionSearchInput.value.trim());
      empty.textContent = searching
        ? t("sessions.noMatch")
        : state.sessionView === "active"
        ? t("sessions.noneInProject")
        : state.sessionView === "archived"
        ? t("sessions.noneArchived")
        : t("sessions.trashEmpty");
      elements.sessionList.append(empty);
    }
  } else {
    for (const session of state.sessions) {
      elements.sessionList.append(createSessionItem(session));
    }
  }
  elements.loadMoreSessionsButton.hidden = !state.sessionCursor;
  updateControls();
}

function createSessionLoadError(message) {
  const container = document.createElement("div");
  container.className = "session-list-empty session-list-error";
  container.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.textContent = t("sessions.loadFailed", { message });
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "quiet";
  retry.textContent = t("common.retry");
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

  if (selectionBar.isSelecting()) {
    const label = document.createElement("label");
    label.className = "session-select-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const selectable = selectionBar.isSelectable(session);
    item.dataset.selectable = String(selectable);
    checkbox.checked = selectable && selectionBar.isSelected(session.id);
    checkbox.disabled = !selectable;
    checkbox.setAttribute("aria-label", t("sessions.selectOne", { title: session.title || t("session.untitled") }));
    if (session.state === "active") {
      label.title = t("session.organizingBusy");
    } else if (!selectable) {
      label.title = t("sessions.otherProject");
    }
    checkbox.addEventListener("change", () => {
      selectionBar.toggle(session.id);
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
  item.append(open);
  if (state.sessionView === "active") item.append(createSessionRename(session));
  item.append(createSessionMark(session));
  return item;
}

function appendSessionText(container, session) {
  const title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = session.title || t("session.untitled");
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
    meta.textContent = date ? t("sessions.lastReply", { date }) : t("sessions.noReplies");
  }
  container.append(title, project, meta);
}

function projectDirectoryName(projectId) {
  return projectDisplayLabel(
    state.projects.find((project) => project.id === projectId),
    state.projects,
  );
}

function createSessionRename(session) {
  const button = document.createElement("button");
  button.className = "session-rename-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-label", t("sessions.renameOne", { title: session.title || t("session.untitled") }));
  button.title = t("rename.title");
  button.append(sessionRenameIcon());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openRenameDialog(session);
  });
  return button;
}

function createSessionMark(session) {
  const button = document.createElement("button");
  button.className = "session-mark-trigger quiet";
  button.type = "button";
  button.setAttribute("aria-pressed", String(Boolean(session.marked)));
  button.setAttribute(
    "aria-label",
    session.marked
      ? t("sessions.unpinOne", { title: session.title || t("session.untitled") })
      : t("sessions.pinOne", { title: session.title || t("session.untitled") }),
  );
  button.title = session.marked ? t("sessions.unpin") : t("sessions.pinHint");
  button.append(sessionMarkIcon(Boolean(session.marked)));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleSessionMark(session);
    if (!session.marked) openRenameDialog(session);
  });
  return button;
}

function sessionRenameIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("session-rename-icon");
  const pencil = document.createElementNS("http://www.w3.org/2000/svg", "path");
  pencil.setAttribute("d", "M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4");
  svg.append(pencil);
  return svg;
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
   * Two separate paths rather than one rotated path: rotation would push the pin head beyond the viewBox
   * and clip it, while diagonals blur at small sizes. The viewBox stays at 24 because paths use a 24-unit grid;
   * CSS sets the rendered size to 17px.
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

function showAlert(message, title = t("alert.title")) {
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
 * Bulk organization applies only to the current project. Sessions pinned across projects appear at the top
 * of “Recent” but must not enter a request targeting the current project.
 */
function sessionSelectable(session) {
  return session.state !== "active" &&
    Boolean(state.projectId) && session.projectId === state.projectId;
}

/** When the open session is in the current list, keeps the right-side title in sync, including renames from another device. */
function syncCurrentSessionTitle() {
  if (!state.sessionId) return;
  const session = visibleSessionSummaries().find((candidate) =>
    candidate.id === state.sessionId && candidate.projectId === state.projectId
  );
  if (!session) return;
  const title = session.title || "";
  if (title === state.sessionTitle) return;
  state.sessionTitle = title;
  updateConversationTitle();
}

async function executeSessionSelectionAction(action, sessionIds) {
  const projectId = state.projectId;
  if (!projectId || sessionIds.length === 0) {
    throw new Error(t("sessions.nothingToOrganize"));
  }
  const result = await request("sessions.mutate", { projectId, sessionIds, action });
  const succeeded = Array.isArray(result?.succeeded) ? result.succeeded : [];
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  if (
    state.sessionId && succeeded.includes(state.sessionId) &&
    (action === "archive" || action.startsWith("trash-") || action === "delete-trash")
  ) {
    resetCurrentSession();
    showEmpty("empty.chooseSession");
  }
  return {
    succeeded,
    failed: failed.map((failure) => ({
      id: failure?.sessionId,
      reason: localize(failure?.text, failure?.message || t("selection.failed")),
    })),
  };
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

function resetCurrentSession() {
  persistCurrentComposerDraft();
  if (state.sessionId) clearCurrentSessionNotice(state.sessionId);
  abortAttachmentUploads();
  clearSessionResumeTimer();
  state.sessionId = null;
  state.sessionOpenState = null;
  closeComposerPicker();
  elements.modelPickerLabel.textContent = t("composer.default");
  elements.permissionPickerLabel.textContent = t("composer.default");
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
    // Once the drawer covers the page, move focus into the sidebar and onto “Collapse” so keyboard users can exit in one step.
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

/** Returns focus to the hamburger when it remains in the sidebar or falls to body as the sidebar becomes inert; does not steal focus from a dialog. */
function restoreFocusAfterMobileSidebar() {
  const active = document.activeElement;
  if (active && active !== document.body && !elements.sessionSidebar.contains(active)) return;
  elements.openSidebarButton.focus();
}

function closeMobileSidebarOnEscape(event) {
  if (event.key !== "Escape" || !state.mobileSidebarOpen) return;
  // A modal opened from the sidebar handles Escape itself. Keep the sidebar open so focus has somewhere to return when the dialog closes.
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
    : state.sessionId
    ? state.sessionTitle || t("session.untitled")
    : "Codex Remote";
}

function syncSidebarState() {
  const sidebarVisible = isMobileNavigation()
    ? state.mobileSidebarOpen
    : !state.sidebarCollapsed;
  elements.sessionSidebar.inert = !sidebarVisible;
  elements.sessionSidebar.setAttribute("aria-hidden", String(!sidebarVisible));
  // When the mobile sidebar covers the page, make the obscured session view unfocusable, unclickable, and hidden from assistive technology.
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
    showEmpty("empty.newSession");
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
      addTaskNote(t("task.failed", { error: localize(task.error) }));
      rendered += 1;
    }
  }
  return rendered;
}

async function loadOlderHistory() {
  if (!state.projectId || !state.sessionId || !state.authenticated ||
      elements.loadOlderButton.disabled) return;
  // This button is removed with the timeline during a session switch, but still reject new clicks here.
  // An issued request also carries the project and session it saw, and the backend does not advance the cursor on a mismatch.
  if (state.navigationBusy) return;
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  const oldHeight = elements.timeline.scrollHeight;
  const oldTop = elements.timeline.scrollTop;
  const existingNodes = new Set(elements.timeline.children);
  elements.loadOlderButton.disabled = true;
  elements.loadOlderButton.textContent = t("timeline.loadingOlder");

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
    elements.loadOlderButton.textContent = t("timeline.loadOlder");
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
    showNotice(t("delivery.cannotStore"), {
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
      showNotice(t("delivery.uncertain"), {
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
    // This message did not reach Codex. Remove the bubble and restore the original text to the composer so
    // the user does not lose their writing, especially when the backend rejects a long message or the connection drops.
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
      ? t("delivery.restoredToDraft", { message: errorMessage(error) })
      : recovered === "volatile"
      ? t("delivery.keptVolatile", { message: errorMessage(error) })
      : t("delivery.keptPending", { message: errorMessage(error) }), {
      lifetime: "persistent",
      tone: "error",
      key: deliveryNoticeKey(outbox.clientMessageId),
    });
  }
}

async function uploadFiles(files, notices = []) {
  // The connection may still be restoring when the system file picker returns; retain the files first and decide when to upload afterward.
  if (!state.sessionId || !state.projectId) return;
  const available = Math.max(0, MAX_MESSAGE_ATTACHMENTS - state.pendingAttachments.length);
  if (files.length && available === 0) {
    notices.push(t("attachment.limit", { count: MAX_MESSAGE_ATTACHMENTS }));
  } else if (files.length > available) {
    notices.push(t("attachment.limitPartial", { count: MAX_MESSAGE_ATTACHMENTS, available }));
  }
  if (notices.length) showNotice(notices.join(" "), TEMPORARY_WARNING);
  await Promise.all(files.slice(0, available).map((file) => uploadFile(file)));
}

async function uploadFile(file) {
  const clientId = createClientMessageId();
  const projectId = state.projectId;
  const sessionId = state.sessionId;
  const draft = {
    clientId,
    originalName: file.name || t("attachment.untitled"),
    size: file.size,
    status: "preparing",
    statusKey: "attachment.preparing",
    file,
    projectId,
    sessionId,
  };
  state.pendingAttachments.push(draft);
  renderAttachmentList();
  updateControls();
  if (file.size > MAX_ATTACHMENT_BYTES) {
    Object.assign(draft, { status: "failed", statusKey: "attachment.tooLarge", file: null });
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
    Object.assign(draft, { status: "queued", statusKey: "attachment.waitingReconnect", statusText: "" });
    renderAttachmentList();
    updateControls();
    return;
  }

  const { clientId, file, projectId, sessionId } = draft;
  const generation = state.generation;
  const controller = new AbortController();
  state.attachmentUploads.set(clientId, controller);
  Object.assign(draft, { status: "preparing", statusKey: "attachment.preparing", statusText: "" });
  renderAttachmentList();
  updateControls();
  try {
    const ticket = await request("attachment.ticket.create", {
      projectId,
      sessionId,
      originalName: file.name || t("attachment.untitled"),
      declaredMime: file.type || "application/octet-stream",
      expectedSize: file.size,
    });
    if (projectId !== state.projectId || sessionId !== state.sessionId) {
      throw new Error(t("attachment.sessionChanged"));
    }
    if (controller.signal.aborted || !state.pendingAttachments.includes(draft)) return;
    if (generation !== state.generation || !state.connectionReady) {
      throw new Error(t("connection.lost"));
    }
    Object.assign(draft, { status: "uploading", statusKey: "attachment.uploading", statusText: "" });
    renderAttachmentList();
    const response = await fetch("/attachments/upload", {
      method: "POST",
      headers: { "x-upload-ticket": ticket.ticket },
      body: file,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(localize(body?.error?.text, body?.error?.message || t("attachment.failed")));
      error.code = body?.error?.code;
      throw error;
    }
    if (!body?.attachment?.id) throw new Error(t("attachment.noId"));
    if (controller.signal.aborted || !state.pendingAttachments.includes(draft) ||
        projectId !== state.projectId || sessionId !== state.sessionId) return;
    Object.assign(draft, body.attachment, {
      clientId,
      status: "ready",
      statusKey: "attachment.uploaded",
      statusText: "",
      file: null,
    });
    persistCurrentComposerDraft();
  } catch (error) {
    if (!controller.signal.aborted && (generation !== state.generation ||
        !state.connectionReady || state.socket?.readyState !== WebSocket.OPEN)) {
      Object.assign(draft, { status: "queued", statusKey: "attachment.waitingReconnect", statusText: "" });
    } else {
      Object.assign(draft, {
        status: "failed",
        statusKey: error?.name === "AbortError" ? "attachment.cancelled" : "",
        statusText: error?.name === "AbortError" ? "" : errorMessage(error),
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
    name.textContent = attachment.originalName || t("attachment.untitled");
    const meta = document.createElement("small");
    meta.className = "attachment-meta";
    meta.textContent = attachment.status === "ready"
      ? `${attachment.id} · ${t("attachment.uploaded")}`
      : attachment.statusText || t(attachment.statusKey || "attachment.processing");
    const remove = document.createElement("button");
    remove.className = "quiet attachment-remove";
    remove.type = "button";
    remove.textContent = t("attachment.remove");
    remove.setAttribute("aria-label", t("attachment.removeOne", { name: attachment.originalName || t("attachment.untitled") }));
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

/** Used only to match an optimistic bubble with a backend event; attachment names are neither concatenated nor parsed again. */
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
  elements.taskButton.dataset.action = "stop";
  elements.taskButton.setAttribute("aria-label", t("task.stopping"));
  elements.taskButton.title = t("task.stopping");
  try {
    const result = await request("task.stop", { projectId, sessionId });
    if (result?.requested === false) {
      state.stopping = false;
      // The compaction command has reached the model and the backend will not interrupt it; the timeline is unchanged and needs no reload.
      if (result.reason === "compact_started") {
        showNotice(t("task.compactStarted"), TEMPORARY_WARNING);
        return;
      }
      if (state.sessionId) await resumeSession(state.sessionId);
      showNotice(t("task.changed"), TEMPORARY_WARNING);
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
  // A queued background task is allowed through when memory measurement degrades. The notice persists with task.starting and must reappear on replay.
  if (
    event.type === "task.starting" && event.sessionId === state.sessionId &&
    localize(event.notice)
  ) {
    showNotice(localize(event.notice), {
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
      showThinking("thinking.queued");
      updateControls();
      break;
    }
    case "task.starting":
      state.running = true;
      state.controlsTask = true;
      setCurrentSessionState("active");
      showThinking("thinking.starting");
      updateControls();
      break;
    case "sessions.changed":
      cancelRemovedOpenIntent(event);
      if (event.closedSessionId === state.sessionId) {
        resetCurrentSession();
        showEmpty("empty.sessionRemoved");
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
      showThinking(event.tool?.kind === "think" ? "thinking.thinking" : "thinking.tool");
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
        addTaskNote(t("task.failed", { error: localize(event.error) }));
        if (!replay) showNotice(localize(event.error), TEMPORARY_ERROR);
      }
      if (event.status === "interrupted") addTaskNote(t("task.stopped"));
      updateControls();
      break;
    case "task.error":
      if (!event.willRetry) hideThinking();
      if (event.willRetry) {
        showNotice(t("task.retrying", { message: localize(event.message) }), {
          lifetime: "state",
          tone: "warning",
          key: taskNoticeKey("retry", event.taskId || event.sessionId),
        });
      } else if (!replay) {
        showNotice(localize(event.message), TEMPORARY_ERROR);
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
    if (event.error && !replay) showNotice(localize(event.error), TEMPORARY_ERROR);
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

/** Displays attachment names verbatim in text nodes; newlines and control characters cannot become Markdown or another attachment. */
function renderMessageAttachments(attachments) {
  const list = document.createElement("div");
  list.className = "message-attachments";
  for (const attachment of attachments) {
    const chip = document.createElement("span");
    chip.className = "message-attachment";
    chip.textContent = attachment.originalName || t("attachment.untitled");
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
 * Gets the output stream for this assistant body, creating a bubble if necessary.
 *
 * Historical messages are rendered and inserted directly without entering the stream map. Reopening an
 * interrupted turn replays them together with events, causing the same body to arrive twice. Without checking
 * the page first, it would render two copies. User bubbles already have this check; add it here as well.
 * Returning null means the body is already on the page and this copy should be discarded.
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
  // After Markdown rendering, the plain-text node is no longer in the document. Any later delta must rerender
  // the whole body or it will write into a detached node and disappear.
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
  const exit = typeof command.exitCode === "number" ? ` · ${t("tool.exitCode", { code: command.exitCode })}` : "";
  command.summary.textContent = `${command.kind} · ${clipTitle(command.title)} · ${status}${exit}`;
  command.pane.replaceChildren();
  command.outputElement = null;
  if (command.kind === "search") {
    appendToolTextBlock(
      command.pane,
      t("tool.query"),
      command.query || (isRunningTool(command) ? t("tool.waitingQuery") : t("tool.noQuery")),
      "command-input",
    );
    appendResourceBlock(command, t("tool.results"), t("tool.noResults"));
    return;
  }
  if (command.kind === "fetch") {
    appendResourceBlock(command, t("tool.address"), t("tool.noAddress"));
    return;
  }
  appendToolTextBlock(command.pane, t("tool.input"), command.input || t("tool.noInput"), "command-input");
  command.outputElement = appendToolTextBlock(
    command.pane,
    t("tool.output"),
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
    empty.textContent = isRunningTool(command) ? t("tool.waitingAddress") : emptyText;
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
  if (!value || typeof value !== "object") return {};
  return {
    ...value,
    title: localize(value.title),
    entries: Array.isArray(value.entries)
      ? value.entries.map((entry) => entry && typeof entry === "object" ? { ...entry, title: localize(entry.title) } : entry)
      : value.entries,
  };
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
    return `${command.truncated ? `${t("tool.truncated")}\n` : ""}${command.output}`;
  }
  return isRunningTool(command) ? t("tool.waitingOutput") : t("tool.noOutput");
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
  const resultTitle = localize(result?.title);
  if (!resultTitle) return;
  if (result.kind === "task") {
    state.rewindTargetTurnId = null;
    state.rewindText = null;
    state.rewindAttachments = [];
  }
  hideEmpty();
  const article = document.createElement("article");
  article.className = "command-result";
  const title = document.createElement("strong");
  title.textContent = resultTitle;
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
      text.textContent = localize(line);
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
  card.className = "permission-card";
  card.dataset.approvalId = approval.id;
  card.dataset.sessionId = sourceSession?.id || sessionId || "";
  const title = document.createElement("p");
  title.className = "permission-card-title";
  title.textContent = approval.reason || (approval.kind === "command"
    ? t("approval.command")
    : approval.kind === "permissions"
    ? t("approval.permissions")
    : t("approval.fileChange"));
  const body = document.createElement("div");
  body.className = "permission-card-body";
  const source = document.createElement("small");
  source.className = "permission-card-detail";
  source.textContent = t("pending.source", { session: pendingRequestSessionLabel(sourceSession, sessionId) });
  body.append(source);
  for (const line of approvalScopeLines(approval)) {
    const detail = document.createElement("small");
    detail.className = "permission-card-detail";
    detail.textContent = line;
    body.append(detail);
  }
  if (approval.canApprove === false) {
    const unavailable = document.createElement("small");
    unavailable.className = "permission-card-detail";
    unavailable.textContent = t("approval.scopeHidden");
    body.append(unavailable);
  }

  const decline = document.createElement("button");
  decline.className = "danger";
  decline.type = "button";
  decline.textContent = t("approval.decline");
  const approve = document.createElement("button");
  approve.className = "primary";
  approve.type = "button";
  approve.textContent = t("approval.approveOnce");
  decline.addEventListener("click", () => void answerApproval(card, approval.id, "decline"));
  approve.addEventListener("click", () => void answerApproval(card, approval.id, "approve_once"));
  const actions = document.createElement("div");
  actions.className = "permission-card-actions";
  actions.append(decline);
  if (approval.canApprove !== false) actions.append(approve);
  card.append(title, body, actions);
  elements.approvalList.append(card);
}

function pendingRequestSessionLabel(sourceSession, fallbackSessionId = null) {
  const sessionId = typeof sourceSession?.id === "string" && sourceSession.id
    ? sourceSession.id
    : fallbackSessionId;
  const title = typeof sourceSession?.title === "string" && sourceSession.title.trim()
    ? sourceSession.title.trim()
    : findSessionSummary(sessionId)?.title || t("pending.untitledSession");
  const shortId = typeof sessionId === "string" && sessionId
    ? sessionId.slice(0, 8)
    : t("pending.unknown");
  return `${title} · ${shortId}`;
}

function approvalScopeLines(approval) {
  const lines = [];
  if (typeof approval.commandSummary === "string" && approval.commandSummary) {
    lines.push(t("approval.commandLine", { command: approval.commandSummary }));
  }
  if (
    approval.network && typeof approval.network.protocol === "string" &&
    typeof approval.network.host === "string"
  ) {
    lines.push(t("approval.network", { target: `${approval.network.protocol}://${approval.network.host}` }));
  }
  if (Array.isArray(approval.permissionSummary)) {
    lines.push(...approval.permissionSummary.map((line) => localize(line)).filter(Boolean));
  }
  if (lines.length === 0) lines.push(t("approval.choose"));
  return lines;
}

async function requestSlashCommand(type, payload = {}) {
  if (type !== "command.run" || payload.command !== "rewind") {
    if (type !== "command.run") return request(type, payload);
    if (!state.projectId || !state.sessionId) {
      throw new Error(t("session.openFirst"));
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
  // The result is already rendered at the end of the reloaded timeline; SlashCommandMenu need not process it again.
  return null;
}

function beginPendingRewind() {
  if (!state.projectId || !state.sessionId || !state.rewindTargetTurnId) {
    throw new Error(t("rewind.none"));
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
    throw new Error(t("rewind.cannotStore"));
  }
  return pending;
}

async function applyRewindResult(result, pending) {
  if (
    !result || result.kind !== "rewind" ||
    !["reverted", "already_reverted", "stale"].includes(result.outcome) ||
    result.targetTurnId !== pending.targetTurnId
  ) {
    throw new Error(t("rewind.badResult"));
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
    throw new Error(t("rewind.notReady"));
  }
  const completed = finishPendingRewind(pending, result.outcome !== "stale");
  if (result.outcome !== "stale") loadComposerDraftForCurrentSession();
  if (completed === "persisted") clearNotice(rewindNoticeKey(pending));
  addCommandResult(result);
  if (opened.notice) showNotice(localize(opened.notice), {
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
      showNotice(t("rewind.confirmFailed", { message: errorMessage(error) }), {
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
  if (!entries) throw new Error(t("rewind.cannotRead"));
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
          ? t("delivery.retryFailedDraft", { message: errorMessage(error) })
          : recovered === "volatile"
          ? t("delivery.retryFailedVolatile", { message: errorMessage(error) })
          : t("delivery.retryFailedKept", { message: errorMessage(error) }), {
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
      statusKey: expired ? "attachment.expired" : "attachment.uploaded",
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
  card.className = "permission-card";
  card.dataset.interactionId = interaction.id;
  card.dataset.sessionId = sourceSession?.id || sessionId || "";
  const heading = document.createElement("p");
  heading.className = "permission-card-title";
  heading.textContent = t("interaction.heading");
  const body = document.createElement("div");
  body.className = "permission-card-body";
  const source = document.createElement("small");
  source.className = "permission-card-detail";
  source.textContent = t("pending.source", { session: pendingRequestSessionLabel(sourceSession, sessionId) });
  body.append(source);

  const fields = new Map();
  let canSubmit = true;
  let mcpForm = null;
  if (interaction.kind === "user_input") {
    for (const question of Array.isArray(interaction.questions) ? interaction.questions : []) {
      const label = document.createElement("label");
      label.textContent = question.question || question.header || t("interaction.choose");
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
      body.append(label);
      let other = null;
      if (question.isOther && Array.isArray(question.options)) {
        other = document.createElement("input");
        other.type = question.isSecret ? "password" : "text";
        other.placeholder = t("interaction.other");
        body.append(other);
      }
      fields.set(question.id, { control, other, multiple: false });
    }
  } else {
    const message = document.createElement("small");
    message.className = "permission-card-detail";
    message.textContent = t("interaction.mcpMessage", {
      server: interaction.serverName || "MCP",
      message: interaction.message || t("interaction.needsConfirm"),
    });
    body.append(message);
    const loginHref = externalLinkHref(interaction.url);
    if (loginHref) {
      const link = document.createElement("a");
      link.href = loginHref;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = t("interaction.openAuth");
      body.append(link);
    } else if (typeof interaction.url === "string" && interaction.url) {
      // The address exists but is not a regular web link. Display it verbatim for manual judgment without
      // making it clickable or allowing confirmation; authorization that was never opened must not be reported complete.
      const rejected = document.createElement("small");
      rejected.className = "permission-card-detail";
      rejected.textContent = t("interaction.notWebLink", { url: interaction.url });
      body.append(rejected);
      canSubmit = false;
    } else {
      mcpForm = normalizeMcpFormSchema(interaction.schema);
      const count = addMcpFormFields(body, fields, mcpForm);
      if (count === 0) {
        const unsupported = document.createElement("small");
        unsupported.className = "permission-card-detail";
        unsupported.textContent = t("interaction.formUnsupported");
        body.append(unsupported);
        canSubmit = false;
      }
    }
  }

  const validation = document.createElement("small");
  validation.className = "interaction-validation";
  validation.role = "alert";
  validation.hidden = true;
  body.append(validation);
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
  cancel.textContent = t("interaction.cancelTurn");
  const submit = document.createElement("button");
  submit.className = "primary";
  submit.type = "button";
  submit.textContent = interaction.kind === "user_input" || interaction.mode !== "url"
    ? t("interaction.submit")
    : t("interaction.done");
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
  actions.className = "permission-card-actions";
  actions.append(cancel);
  if (canSubmit) actions.append(submit);
  card.append(heading, body, actions);
  elements.approvalList.append(card);
}

/**
 * Determines whether an externally sourced address may be presented as a clickable link.
 *
 * sanitizeHref already blocks protocols such as javascript:. This additionally requires HTTP(S) because
 * these addresses come from MCP servers or tool output rather than being constructed by this page.
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
        blank.textContent = fieldSchema.required ? t("interaction.choose") : t("interaction.skip");
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
        ["", fieldSchema.required ? t("interaction.choose") : t("interaction.skip")],
        ["true", t("interaction.yes")],
        ["false", t("interaction.no")],
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
  message.textContent = t(result.text.key, result.text.params);
  message.hidden = false;
  const control = fields.get(result.fieldId)?.control;
  control?.setCustomValidity?.(message.textContent);
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
  const organizingBusy = state.running || projectHasActiveTask;
  const selectableCount = visibleSessionSummaries().filter(sessionSelectable).length;
  elements.projectSelect.disabled = !connected || navigationLocked;
  elements.newSessionButton.disabled = !connected || navigationLocked ||
    !state.projectId;
  elements.sessionSearchInput.disabled = !connected || navigationBusy ||
    !state.projectId;
  elements.selectSessionsButton.disabled = !connected || navigationLocked ||
    organizingBusy || selectableCount === 0;
  elements.selectSessionsButton.title = organizingBusy
    ? t("session.organizingBusy")
    : t("sidebar.select");
  selectionBar.setDisabled(
    !connected || navigationBusy || busy || organizingBusy,
    organizingBusy ? t("session.organizingBusy") : "",
  );
  elements.loadMoreSessionsButton.disabled = !connected || navigationBusy;
  elements.sessionViewBackButton.disabled = !connected || navigationBusy;
  elements.archivedSessionsButton.disabled = !connected || navigationBusy;
  elements.trashSessionsButton.disabled = !connected || navigationBusy;
  for (const item of elements.sessionList.querySelectorAll(".session-item")) {
    const itemIsActive = item.dataset.state === "active";
    const itemIsSelectable = item.dataset.selectable === "true";
    for (const button of item.querySelectorAll("button")) {
      const opensSession = button.classList.contains("session-open");
      const cannotOpen = opensSession && state.sessionView !== "active";
      button.disabled = !connected || navigationLocked || cannotOpen ||
        (!opensSession && (state.running || projectHasActiveTask || itemIsActive));
    }
    for (const checkbox of item.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = !connected || navigationBusy || busy || organizingBusy ||
        itemIsActive || !itemIsSelectable;
      checkbox.title = organizingBusy ? t("session.organizingBusy") : "";
    }
  }
  elements.messageInput.disabled = !connected || !hasSession;
  elements.messageInput.placeholder = !hasSession
    ? t("composer.placeholderNoSession")
    : state.running
    ? t("composer.placeholderRunning")
    : state.commandBusy
    ? t("composer.placeholderBusy")
    : t("composer.placeholder");
  const controlsDisabled = !connected || !hasSession || busy || navigationBusy;
  // Model and permissions may change while a response is in progress; the backend records them for the next turn.
  const pickersDisabled = !connected || !hasSession || state.commandBusy || navigationBusy;
  elements.commandMenuButton.disabled = controlsDisabled;
  if (controlsDisabled) clearAttachmentDrag();
  elements.modelPickerButton.disabled = pickersDisabled;
  elements.permissionPickerButton.disabled = pickersDisabled;
  if (pickersDisabled) closeComposerPicker();
  if (controlsDisabled) slashCommands.close();
  if (state.stopping) {
    elements.taskButton.dataset.action = "stop";
    elements.taskButton.setAttribute("aria-label", t("task.stopping"));
    elements.taskButton.title = t("task.stopping");
    elements.taskButton.classList.toggle("primary", false);
    elements.taskButton.classList.toggle("danger", false);
    elements.taskButton.disabled = true;
  } else {
    const taskLabel = state.running ? t("composer.stop") : t("composer.send");
    elements.taskButton.dataset.action = state.running ? "stop" : "send";
    elements.taskButton.setAttribute("aria-label", taskLabel);
    elements.taskButton.title = taskLabel;
    elements.taskButton.classList.toggle("primary", !state.running);
    elements.taskButton.classList.toggle("danger", false);
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

function showEmpty(key) {
  clearTimeline();
  setKeyedText(elements.emptyState.querySelector("p"), key);
  elements.timeline.append(elements.emptyState);
}

function showSessionLoading(loadState = "loading") {
  showEmpty(loadState === "queued"
    ? "loading.queued"
    : loadState === "starting"
    ? "loading.starting"
    : loadState === "restoring"
    ? "loading.restoring"
    : "loading.session");
}

function hideEmpty() {
  if (elements.emptyState.parentElement) elements.emptyState.remove();
}

function showThinking(key = "thinking.thinking") {
  hideEmpty();
  setKeyedText(elements.thinkingLabel, key);
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
  // Attachments come from structured backend fields; text resembling an attachment line in the body remains plain body text.
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

function setConnectionStatus(status, key) {
  elements.connectionStatus.dataset.state = status;
  setKeyedText(elements.connectionStatus, key);
}

/** Text in the page markup that scripts rewrite, so it is set here rather than marked for i18n.js. */
function labelScriptedText() {
  setConnectionStatus("connecting", "connection.connecting");
  setKeyedText(elements.emptyState.querySelector("p"), "empty.chooseSession");
  setKeyedText(elements.thinkingLabel, "thinking.thinking");
  elements.loadOlderButton.textContent = t("timeline.loadOlder");
  elements.modelPickerLabel.textContent = t("composer.default");
  elements.permissionPickerLabel.textContent = t("composer.default");
  renderSessionViewTitle();
}

/**
 * Rewrites the text scripts have set after a language switch. Conversation content already on screen keeps
 * its language; new content, and a session opened again, use the new one.
 */
function relabelInterface() {
  for (const element of document.querySelectorAll("[data-text-key]")) {
    element.textContent = t(element.dataset.textKey);
  }
  if (!elements.loadOlderButton.disabled) elements.loadOlderButton.textContent = t("timeline.loadOlder");
  renderSessionViewTitle();
  updateConversationTitle();
  selectionBar.relabel();
  renderSessionList();
  renderAttachmentList();
  renderSessionMetrics();
  if (state.sessionId) {
    void refreshPickerLabels();
  } else {
    elements.modelPickerLabel.textContent = t("composer.default");
    elements.permissionPickerLabel.textContent = t("composer.default");
  }
  if (elements.appSettingsDialog.open) {
    renderModelDefaults();
    renderPermissionDefaults();
  }
  updateControls();
}

/** Shows interface text and remembers its key, so a language switch can rewrite it in place. */
function setKeyedText(element, key) {
  element.dataset.textKey = key;
  element.textContent = t(key);
}

function showNotice(text, options = TEMPORARY_WARNING) {
  return noticeController.show(text, options);
}

function clearNotice(key) {
  return noticeController.clear(key);
}

function commandStatus(status) {
  return status === "completed"
    ? t("tool.completed")
    : status === "failed"
    ? t("tool.failed")
    : status === "interrupted"
    ? t("tool.interrupted")
    : status === "declined"
    ? t("tool.declined")
    : status === "inProgress" || status === "in_progress" || status === "pending"
    ? t("tool.running")
    : status || t("tool.ended");
}

function formatDate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return formatDisplayTime(
    milliseconds,
    resolveDisplayTimeZone(state.displayTimezone, deviceTimeZone()),
  );
}

async function openAppSettings() {
  if (state.appSettingsBusy) return;
  const generation = ++state.appSettingsLoadGeneration;
  renderThemeChoice();
  renderLanguageChoice();
  syncAppSettingsForm();
  state.appSettingsLoadState = "loading";
  setAllAppSettingsStatuses("");
  state.settingsModelsState = "loading";
  state.settingsModelsError = "";
  state.modelDefaultsMessage = "";
  state.settingsPermissionsState = "loading";
  state.settingsPermissionsError = "";
  renderModelDefaults();
  renderPermissionDefaults();
  updateAppSettingsControls();
  const settings = loadBackendSettings(generation);
  const models = loadSettingsModels(generation);
  const permissions = loadSettingsPermissions(generation);
  await settings;
  if (generation !== state.appSettingsLoadGeneration) return;
  if (!elements.appSettingsDialog.open) elements.appSettingsDialog.showModal();
  void models;
  void permissions;
}

function renderThemeChoice() {
  const theme = window.codexRemoteTheme;
  elements.themeSetting.hidden = !theme;
  if (!theme) return;
  const current = theme.get();
  for (const button of elements.themeOptions.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === current));
  }
}

// Language is stored only in the current browser; i18n.js owns the preference and applies it to the page.
function renderLanguageChoice() {
  const i18n = window.codexRemoteI18n;
  elements.languageSetting.hidden = !i18n;
  if (!i18n) return;
  const current = i18n.get();
  for (const button of elements.languageOptions.querySelectorAll("[data-language-choice]")) {
    button.setAttribute("aria-pressed", String(button.dataset.languageChoice === current));
  }
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
  const prefs = state.displayTimezone;
  elements.displayTimezoneSelect.value = prefs.followDevice ? "device" : prefs.cityTimeZone;
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
    state.appSettingsLoadState = "ready";
    setAllAppSettingsStatuses("");
  } catch (error) {
    if (generation !== state.appSettingsLoadGeneration) return;
    state.appSettingsLoadState = "error";
    setAllAppSettingsStatuses(errorMessage(error), "error");
  }
  updateAppSettingsControls();
}

async function loadSettingsModels(generation) {
  try {
    const data = await request("settings.models");
    if (generation !== state.appSettingsLoadGeneration) return;
    if (!Array.isArray(data)) throw new Error(t("settings.badModelList"));
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
  const modelOptions = [{ value: "", label: t("settings.followCodexDefault") }];
  if (model && !selectedModel) {
    modelOptions.push({
      value: model,
      label: t(ready ? "settings.optionUnavailable" : "settings.optionSaved", { value: model }),
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
    label: model === null ? t("settings.followCodexDefault") : t("settings.followModelDefault"),
  }];
  if (model && effort && !selectedModel?.supportedReasoningEfforts.some(
    (option) => option.reasoningEffort === effort,
  )) {
    effortOptions.push({
      value: effort,
      label: t(ready ? "settings.optionUnavailable" : "settings.optionSaved", { value: effort }),
    });
  }
  if (selectedModel) {
    effortOptions.push(...selectedModel.supportedReasoningEfforts.map((option) => ({
      value: option.reasoningEffort,
      label: option.reasoningEffort === selectedModel.defaultReasoningEffort
        ? t("settings.modelDefaultEffort", { value: option.reasoningEffort })
        : option.reasoningEffort,
    })));
  }
  replaceSelectOptions(elements.defaultReasoningEffortSelect, effortOptions, effort ?? "");

  elements.defaultModelSelect.disabled = state.appSettingsBusy || state.appSettingsLoadState !== "ready" || !ready;
  elements.defaultReasoningEffortSelect.disabled = state.appSettingsBusy ||
    state.appSettingsLoadState !== "ready" || !ready || model === null || !selectedModel;
  elements.modelDefaultsStatus.textContent = state.modelDefaultsMessage
    ? t(state.modelDefaultsMessage)
    : state.settingsModelsState === "loading"
    ? t("settings.loadingModels")
    : state.settingsModelsState === "error"
    ? t("settings.modelsFailed", { message: state.settingsModelsError })
    : model && !selectedModel
    ? t("settings.savedModelMissing")
    : t("settings.modelDefaultsHint");
}

async function loadSettingsPermissions(generation) {
  try {
    const data = await request("settings.permissions");
    if (generation !== state.appSettingsLoadGeneration) return;
    if (!Array.isArray(data)) throw new Error(t("settings.badPermissionList"));
    state.settingsPermissions = data.flatMap((profile) =>
      profile && typeof profile.id === "string" && profile.id &&
        localize(profile.label) && profile.allowed === true
        ? [{
          id: profile.id,
          label: profile.label,
          description: profile.description ?? "",
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
  const options = [{ value: "", label: t("settings.followCodexDefault") }];
  if (selected && !profile) {
    options.push({
      value: selected,
      label: t(ready ? "settings.optionUnavailable" : "settings.optionSaved", { value: selected }),
    });
  }
  if (ready) {
    options.push(...state.settingsPermissions.map((candidate) => ({
      value: candidate.id,
      label: localize(candidate.label),
    })));
  }
  replaceSelectOptions(elements.defaultPermissionsSelect, options, selected ?? "");
  elements.defaultPermissionsSelect.disabled = state.appSettingsBusy ||
    state.appSettingsLoadState !== "ready" || !ready;
  elements.defaultPermissionsStatus.textContent = state.settingsPermissionsState === "loading"
    ? t("settings.loadingPermissions")
    : state.settingsPermissionsState === "error"
    ? t("settings.permissionsFailed", { message: state.settingsPermissionsError })
    : selected && !profile
    ? t("settings.savedPermissionMissing")
    : localize(profile?.description) || t("settings.noPermissionDefault");
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

async function saveAppSettings(section) {
  if (state.appSettingsBusy || state.appSettingsLoadState !== "ready") return;
  const defaultsChanged = state.defaultModelDraft !== state.defaultModel ||
    state.defaultReasoningEffortDraft !== state.defaultReasoningEffort ||
    state.defaultPermissionsDraft !== state.defaultPermissions;
  const instructionsChanged = elements.developerInstructionsInput.value !== state.developerInstructions;
  if ((section === "defaults" && !defaultsChanged) ||
    (section === "instructions" && !instructionsChanged)) {
    setAppSettingsStatus(section, "");
    return;
  }
  if (section !== "defaults" && section !== "instructions") return;
  state.appSettingsBusy = true;
  setAppSettingsStatus(section, t("settings.saving"));
  updateAppSettingsControls();
  try {
    const payload = section === "defaults"
      ? {
        defaultModel: state.defaultModelDraft,
        defaultReasoningEffort: state.defaultReasoningEffortDraft,
        defaultPermissions: state.defaultPermissionsDraft,
      }
      : { developerInstructions: elements.developerInstructionsInput.value };
    const data = await request("settings.update", payload);
    if (section === "defaults") {
      state.defaultModel = typeof data?.defaultModel === "string" ? data.defaultModel : null;
      state.defaultReasoningEffort = typeof data?.defaultReasoningEffort === "string"
        ? data.defaultReasoningEffort
        : null;
      state.defaultPermissions = typeof data?.defaultPermissions === "string"
        ? data.defaultPermissions
        : null;
      state.defaultModelDraft = state.defaultModel;
      state.defaultReasoningEffortDraft = state.defaultReasoningEffort;
      state.defaultPermissionsDraft = state.defaultPermissions;
      renderModelDefaults();
      renderPermissionDefaults();
    } else {
      const value = typeof data?.developerInstructions === "string" ? data.developerInstructions : "";
      state.developerInstructions = value;
      elements.developerInstructionsInput.value = value;
    }
    setAppSettingsStatus(section, "");
  } catch (error) {
    setAppSettingsStatus(section, errorMessage(error), "error");
  } finally {
    state.appSettingsBusy = false;
    updateAppSettingsControls();
  }
}

function appSettingsStatusElement(section) {
  return section === "defaults"
    ? elements.modelDefaultsSaveStatus
    : elements.developerInstructionsSaveStatus;
}

function setAppSettingsStatus(section, text, kind = "") {
  const status = appSettingsStatusElement(section);
  status.textContent = text;
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}

function setAllAppSettingsStatuses(text, kind = "") {
  for (const section of ["defaults", "instructions"]) {
    setAppSettingsStatus(section, text, kind);
  }
}

function updateAppSettingsControls() {
  const disabled = state.appSettingsBusy;
  const serverReady = state.appSettingsLoadState === "ready";
  elements.developerInstructionsInput.disabled = disabled || !serverReady;
  elements.developerInstructionsInfoButton.disabled = disabled;
  elements.modelDefaultsInfoButton.disabled = disabled;
  elements.appSettingsCloseButton.disabled = disabled;
  elements.modelDefaultsSaveButton.disabled = disabled || !serverReady;
  elements.developerInstructionsSaveButton.disabled = disabled || !serverReady;
  syncAppSettingsForm();
  renderModelDefaults();
  renderPermissionDefaults();
}

/** Like appearance and language, the time zone applies and persists on change instead of waiting for Save.
 * Choosing "follow device" keeps the last city so switching back restores it. */
function selectDisplayTimezone() {
  const value = elements.displayTimezoneSelect.value;
  state.displayTimezone = saveDisplayTimezonePreference(value === "device"
    ? { followDevice: true, cityTimeZone: state.displayTimezone.cityTimeZone }
    : { followDevice: false, cityTimeZone: value });
  syncAppSettingsForm();
  refreshDisplayedTimes();
}

/** Another tab saved the time zone. */
function applyStoredDisplayTimezone() {
  state.displayTimezone = loadDisplayTimezonePreference();
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

/** Status line for the login card; regular notices, progress, and errors each use their own color. */
function setLoginStatus(text, tone = null) {
  elements.loginStatus.textContent = text;
  if (tone) elements.loginStatus.dataset.tone = tone;
  else delete elements.loginStatus.dataset.tone;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : t("request.failed");
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
    : new RecoveryStateError("recovery_unavailable", t("recovery.unavailable"), {
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
      label: t("recovery.copyRaw"),
      run: async () => {
        if (!navigator.clipboard?.writeText) throw new Error(t("recovery.cannotCopy"));
        await navigator.clipboard.writeText(`${problem.key || RECOVERY_KEY}\n${problem.raw}`);
        showNotice(t("recovery.copied"), TEMPORARY_INFO);
      },
    };
  }
  showNotice(problem.code === "recovery_corrupt"
    ? t("recovery.corruptNotice")
    : t("recovery.unavailableNotice"), options);
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
    // The current page remains usable when the browser disables local storage.
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as above.
  }
}

function unavailableSlashCommands() {
  return {
    async load() {},
    toggleAll() { showNotice(t("slash.menuUnavailable"), TEMPORARY_WARNING); },
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
  if (!element) throw new Error(`Missing page element: ${id}`);
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
    // If a session switch or Worker termination occurs during the query, fetch fresh data after it completes.
    if (metricsRefreshQueued) void refreshSessionMetrics();
  }
  renderSessionMetrics();
}

function renderSessionMetrics() {
  elements.sessionMetrics.hidden = !state.sessionId;
  if (!state.sessionId) { elements.sessionMetrics.textContent = ""; return; }
  const metrics = state.metrics;
  const parts = [metrics?.context
    ? t("metrics.context", { percent: metrics.context.percentage.toFixed(1) })
    : t("metrics.contextPending")];
  if (metrics?.windows?.length) {
    for (const quota of metrics.windows) {
      const left = typeof quota.remainingPercent === "number"
        ? `${quota.remainingPercent.toFixed(1)}%` : t("metrics.unknown");
      const reset = formatDate(quota.resetsAt);
      const label = localize(quota.label);
      parts.push(reset
        ? t("metrics.quotaReset", { label, left, reset })
        : t("metrics.quota", { label, left }));
    }
  } else parts.push(t("metrics.quotaUnavailable"));
  parts.push(metrics?.lastReplyAt
    ? t("metrics.lastReply", { date: formatDate(metrics.lastReplyAt) }) : t("metrics.lastReplyUnavailable"));
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
  elements.sessionMetrics.title = t("metrics.hint");
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshSessionMetrics();
});


// Align the first desktop-sidebar row with the actual height of the right header, following banners, fonts, and window changes.
const conversationHeader = document.querySelector(".app-header");
const headerHeightObserver = new ResizeObserver(() => {
  const height = conversationHeader.getBoundingClientRect().height;
  if (height > 0) {
    elements.appView.style.setProperty("--conversation-header-height", `${height}px`);
  }
});
headerHeightObserver.observe(conversationHeader);

// Both selection entry points share a menu; data and changes use the existing command interface.
function closeComposerPicker() {
  elements.composerPickerMenu.hidden = true;
  // Each close invalidates one generation so an open request already in flight is discarded when it returns.
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
      const label = localize(selected?.label) || t("composer.default");
      const kind = command === "model" ? "model" : "permission";
      composerPickers[kind].label.textContent = label;
      composerPickers[kind].button.title = label;
    } catch { /* The backend rejects queries while a task starts or finishes; read again the next time the menu opens. */ }
  }));
}

/**
 * Chooses which button receives focus when the menu opens.
 *
 * This cannot be one comma-separated selector: that returns the first element in document order matching
 * any branch instead of prioritizing the earlier branch. The checked option always follows the first enabled
 * button, especially when “‹ Back” is present, so focus would never reach the checked option.
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
    back.textContent = `‹ ${t("common.back")}`;
    back.addEventListener("click", onBack);
    heading.append(back);
  }
  const label = document.createElement("strong");
  label.textContent = localize(title);
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
    name.textContent = localize(item.label) || item.id;
    const detail = document.createElement("span");
    detail.className = "composer-picker-description";
    detail.textContent = localize(item.description);
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
    composerPickers[kind].label.textContent = localize(selected?.label) || t("composer.default");
    const choose = async (item, argument = null) => {
      if (state.projectId !== projectId || state.sessionId !== sessionId || trigger.disabled) return;
      if (item.danger && !window.confirm(t("composer.fullAccessConfirm"))) return;
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
            t("composer.effortHint"),
          disabled: !selected?.items?.length,
        });
      }
      renderComposerPicker(command === "model" ? t("composer.chooseModel") : t("composer.permissionMode"), rows, item => {
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
    input.value = fromSession.title || "";
  } else {
    if (!state.sessionId || state.commandBusy || state.running) return;
    dialog.dataset.sessionId = state.sessionId;
    dialog.dataset.projectId = state.projectId || "";
    input.value = initialTitle ?? state.sessionTitle ?? "";
  }
  // An untitled session shows its default name only as a hint, so saving untouched never stores it as a name.
  input.placeholder = t("session.untitled");
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
  if (!title) { status.textContent = t("rename.empty"); return; }
  const sessionId = dialog.dataset.sessionId;
  const projectId = dialog.dataset.projectId || state.projectId;
  if (!sessionId || !projectId) {
    status.textContent = t("rename.missing");
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
