/*
 * Interface text in every supported language, keyed by a stable id. Each entry lists all languages side by side
 * so a missing translation is easy to spot. {name} placeholders are filled in by codexRemoteI18n.t.
 */
window.codexRemoteStrings = {
  "login.tokenLabel": { zh: "访问令牌", en: "Access token" },
  "login.tokenHint": { zh: "（登录状态存于浏览器）", en: " (sign-in is kept in this browser)" },
  "login.connect": { zh: "连接", en: "Connect" },
  "login.tokenMissing": { zh: "请输入访问令牌。", en: "Enter the access token." },
  "login.tokenInvalid": { zh: "访问令牌有误，请重新输入。", en: "The access token is incorrect. Try again." },
  "login.connecting": { zh: "正在连接主机……", en: "Connecting to the host…" },
  "login.noResponse": {
    zh: "没有收到服务器响应。请求可能未到达服务器，或者连接在服务器响应前中断。请检查网络或代理设置后重试。",
    en: "No response from the server. The request may not have reached it, or the connection dropped before it replied. Check your network or proxy settings and try again.",
  },
  "login.required": { zh: "请登录。", en: "Please sign in." },
  "login.unavailable": { zh: "登录服务暂时不可用。", en: "The sign-in service is temporarily unavailable." },
  "login.hostUnreachable": { zh: "现在无法连接主机。", en: "Can't reach the host right now." },

  "boot.starting": { zh: "页面正在启动……", en: "Starting…" },
  "boot.failed": {
    zh: "页面脚本未能启动，请刷新页面；如果仍然出现此提示，请更新浏览器。",
    en: "The page script failed to start. Refresh the page; if this message persists, update your browser.",
  },
  "boot.stillStarting": { zh: "页面仍在启动，请稍候……", en: "The page is still starting, please wait…" },
  "boot.pullToRefresh": { zh: "下拉刷新", en: "Pull to refresh" },
  "boot.releaseToRefresh": { zh: "松开刷新", en: "Release to refresh" },

  "common.cancel": { zh: "取消", en: "Cancel" },
  "common.close": { zh: "关闭", en: "Close" },
  "common.gotIt": { zh: "知道了", en: "Got it" },
  "common.save": { zh: "保存", en: "Save" },

  "sidebar.navigation": { zh: "会话导航", en: "Session navigation" },
  "sidebar.collapse": { zh: "收起会话列表", en: "Collapse session list" },
  "sidebar.open": { zh: "打开会话列表", en: "Open session list" },
  "sidebar.close": { zh: "关闭会话列表", en: "Close session list" },
  "sidebar.project": { zh: "项目", en: "Project" },
  "sidebar.newSession": { zh: "新会话", en: "New session" },
  "sidebar.search": { zh: "搜索会话", en: "Search sessions" },
  "sidebar.backToRecent": { zh: "返回最近会话", en: "Back to recent sessions" },
  "sidebar.archived": { zh: "已归档", en: "Archived" },
  "sidebar.trash": { zh: "回收站", en: "Trash" },
  "sidebar.select": { zh: "选择", en: "Select" },
  "sidebar.loadMore": { zh: "加载更多", en: "Load more" },

  "approvals.list": { zh: "所有会话的待处理请求", en: "Pending requests from all sessions" },
  "notice.close": { zh: "关闭提示", en: "Dismiss notice" },

  "composer.message": { zh: "消息", en: "Message" },
  "composer.actions": { zh: "快捷操作", en: "Quick actions" },
  "composer.moreActions": { zh: "更多操作", en: "More actions" },
  "composer.model": { zh: "模型", en: "Model" },
  "composer.permissions": { zh: "权限", en: "Permissions" },
  "composer.sendHint": { zh: "电脑可按 Ctrl / ⌘ + Enter 发送", en: "On a computer, press Ctrl / ⌘ + Enter to send" },

  "settings.title": { zh: "应用设置", en: "App settings" },
  "settings.browserOnly": { zh: "只影响当前浏览器。", en: "Only affects this browser." },
  "settings.theme": { zh: "外观", en: "Appearance" },
  "settings.themeSystem": { zh: "跟随系统", en: "Follow system" },
  "settings.themeLight": { zh: "浅色", en: "Light" },
  "settings.themeDark": { zh: "深色", en: "Dark" },
  "settings.language": { zh: "语言", en: "Language" },
  "settings.languageSystem": { zh: "跟随浏览器", en: "Follow browser" },
  "settings.modelDefaults": { zh: "新会话默认值", en: "New session defaults" },
  "settings.modelDefaultsAbout": { zh: "关于新会话默认值的说明", en: "About new session defaults" },
  "settings.modelDefaultsShared": {
    zh: "默认模型、思考强度和权限由 Codex Remote 后端保存，连到同一后端的设备共用。",
    en: "The default model, reasoning effort and permissions are saved by the Codex Remote backend and shared by every device connected to it.",
  },
  "settings.modelDefaultsNewOnly": {
    zh: "它们只在新建会话时使用。打开旧会话不会改变原来的选择，会话里临时切换也不会写回这里。",
    en: "They apply only when a session is created. Opening an existing session keeps its own choices, and switching inside a session does not write back here.",
  },
  "settings.modelDefaultsFollow": {
    zh: "「跟随 Codex 默认」不会固定当前默认值；以后 Codex 的默认值变化时，新会话会跟着变化。",
    en: "\"Follow Codex default\" does not pin today's default; when Codex changes its default later, new sessions follow.",
  },
  "settings.modelDefaultsPermissions": {
    zh: "权限与 Codex 桌面端一致：完全访问不受沙箱限制，也不再询问批准；其他权限遇到越界或敏感操作时会询问。默认权限不可用时，这次新会话改用 Codex 默认权限并给出提示。",
    en: "Permissions match the Codex desktop app: full access runs outside the sandbox and never asks for approval; other levels ask before out-of-bounds or sensitive actions. If the default permissions are unavailable, the new session uses Codex's default permissions and shows a notice.",
  },
  "settings.readOnOpen": {
    zh: "设置窗口打开时读取一次后端内容；要查看其他设备后来保存的内容，请关闭后重新打开。",
    en: "Settings are read from the backend once when this window opens; to see changes saved later from another device, close and reopen it.",
  },
  "settings.defaultModel": { zh: "默认模型", en: "Default model" },
  "settings.defaultReasoningEffort": { zh: "默认思考强度", en: "Default reasoning effort" },
  "settings.defaultPermissions": { zh: "默认权限", en: "Default permissions" },
  "settings.developerInstructions": { zh: "附加 Developer 指令", en: "Additional developer instructions" },
  "settings.developerInstructionsAbout": { zh: "关于附加 Developer 指令的说明", en: "About additional developer instructions" },
  "settings.developerInstructionsShared": {
    zh: "这段内容由 Codex Remote 后端保存。连到同一后端的设备共用这一份；不同后端之间不会同步。",
    en: "This text is saved by the Codex Remote backend. Devices connected to the same backend share it; different backends do not sync.",
  },
  "settings.developerInstructionsInjection": {
    zh: "新建或重新载入会话时，会通过 Codex App Server 的 developerInstructions 注入。",
    en: "It is injected through the Codex App Server's developerInstructions when a session is created or reloaded.",
  },
  "settings.developerInstructionsPriority": {
    zh: "Developer 指令的优先级高于用户消息。",
    en: "Developer instructions take priority over user messages.",
  },
  "settings.developerInstructionsScope": {
    zh: "它不会替换 Codex 自带的基础指令，也不能用来控制完整的系统提示词。",
    en: "It does not replace Codex's built-in base instructions and cannot control the full system prompt.",
  },
  "settings.developerInstructionsEmpty": {
    zh: "留空时只使用 Codex Remote 内置的 Developer 指令。改动不会影响已经在运行的任务。",
    en: "When empty, only Codex Remote's built-in developer instructions are used. Changes do not affect tasks already running.",
  },
  "settings.developerInstructionsPlaceholder": {
    zh: "输入希望 Codex 始终遵循的附加指令……",
    en: "Enter extra instructions Codex should always follow…",
  },
  "settings.developerInstructionsHelp": {
    zh: "用于补充 Codex 的协作方式；在新建或重新载入会话时生效。",
    en: "Adds to how Codex works with you; takes effect when a session is created or reloaded.",
  },
  "settings.displayTimezone": { zh: "显示时区", en: "Display time zone" },
  "settings.followDevice": { zh: "跟随设备", en: "Follow device" },
  "settings.city": { zh: "城市", en: "City" },
  "settings.displayTimezoneHelp": {
    zh: "仅影响这台设备上的时间显示，自动考虑夏令时。",
    en: "Only affects how times are shown on this device; daylight saving time is handled automatically.",
  },

  "city.shanghai": { zh: "上海", en: "Shanghai" },
  "city.tokyo": { zh: "东京", en: "Tokyo" },
  "city.london": { zh: "伦敦", en: "London" },
  "city.paris": { zh: "巴黎", en: "Paris" },
  "city.newYork": { zh: "纽约", en: "New York" },
  "city.losAngeles": { zh: "洛杉矶", en: "Los Angeles" },

  "rename.title": { zh: "重命名", en: "Rename" },
  "rename.label": { zh: "会话名称", en: "Session name" },

  "viewer.loginLink": { zh: "登录后查看", en: "Sign in to view" },
};
