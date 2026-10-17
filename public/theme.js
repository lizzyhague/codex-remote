/*
 * 在样式加载前同步决定深浅主题，避免页面先显示深色再切换。
 * 选择只保存在当前浏览器；未选择时跟随系统，并立即响应系统外观变化。
 */
(function () {
  var KEY = "codex-remote.theme";
  var root = document.documentElement;
  var media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  var choice = read();

  function normalize(value) {
    return value === "light" || value === "dark" ? value : "system";
  }

  function read() {
    try { return normalize(localStorage.getItem(KEY)); }
    catch (error) { return "system"; }
  }

  function apply() {
    var theme = choice === "system" ? (media && media.matches ? "light" : "dark") : choice;
    root.setAttribute("data-theme", theme);
  }

  apply();
  if (media) {
    if (typeof media.addEventListener === "function") media.addEventListener("change", apply);
    else if (typeof media.addListener === "function") media.addListener(apply);
  }
  window.addEventListener("storage", function (event) {
    if (event.key !== KEY && event.key !== null) return;
    choice = read();
    apply();
  });

  window.codexRemoteTheme = {
    get: function () { return choice; },
    set: function (value) {
      choice = normalize(value);
      try {
        if (choice === "system") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, choice);
      } catch (error) {
        // 浏览器禁用本地存储时，选择仍对当前页面生效。
      }
      apply();
    },
  };
}());
