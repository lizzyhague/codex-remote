/** Interface text from i18n.js; looked up on each call so a language switch applies to the next render. */
const t = (key, params) => globalThis.codexRemoteI18n ? globalThis.codexRemoteI18n.t(key, params) : key;
/** Command titles and confirmations come from the backend as { key, params }. */
const localize = (value) => globalThis.codexRemoteI18n
  ? globalThis.codexRemoteI18n.localize(value)
  : typeof value === "string" ? value : "";

export class SlashCommandMenu {
  constructor(options) {
    this._input = options.input;
    this._element = options.element;
    this._button = options.button ?? null;
    this._request = options.request;
    this._onResult = options.onResult;
    this._onError = options.onError;
    this._onBusy = options.onBusy;
    this._onInputChanged = options.onInputChanged;
    this._actions = options.actions ?? [];
    this._onRename = options.onRename;
    this._fromButton = false;
    this._commands = [];
    this._visibleItems = [];
    this._selectedIndex = 0;
    this._busy = false;
    this._element.addEventListener?.("keydown", (event) => {
      this.handleKeydown(event);
    });
  }

  async load() {
    try {
      const data = await this._request("commands.list");
      // The composer dropdown buttons now own model and permissions, so omit them from the slash menu.
      this._commands = Array.isArray(data?.commands)
        ? data.commands.filter(command => !["model", "permissions"].includes(command.name)) : [];
      this.handleInput();
    } catch (error) {
      this._onError(error);
    }
  }

  close({ restoreButtonFocus = false } = {}) {
    const restoreFocus = restoreButtonFocus && this._fromButton;
    this._element.hidden = true;
    this._element.replaceChildren();
    this._button?.setAttribute("aria-expanded", "false");
    this._visibleItems = [];
    this._selectedIndex = 0;
    this._fromButton = false;
    if (restoreFocus) this._button?.focus();
  }

  toggleAll() {
    if (this._busy) return;
    if (!this._element.hidden) { this.close(); return; }
    this._fromButton = true;
    this._renderCommands(this._commands.filter(command => command.name !== "rename"), true);
  }

  handleInput() {
    this._fromButton = false;
    if (this._busy) return;
    const value = this._input.value;
    const match = /^\/([^\s/]*)$/.exec(value);
    if (!match || !this._commands.length) {
      this.close();
      return;
    }
    const query = match[1].toLowerCase();
    const commands = this._commands.filter((command) =>
      typeof command?.name === "string" && command.name.startsWith(query)
    );
    this._renderCommands(commands);
  }

  handleKeydown(event) {
    if (this._element.hidden || !this._visibleItems.length) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close({ restoreButtonFocus: true });
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this._moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    if (event.key === "Tab" && this._fromButton) {
      this.close({ restoreButtonFocus: true });
      return false;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      this._visibleItems[this._selectedIndex]?.click();
      return true;
    }
    return false;
  }

  async submit(text) {
    if (!text.startsWith("/")) return false;
    this._fromButton = false;
    const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) {
      this._onError(new Error(t("slash.unrecognized")));
      return true;
    }
    const command = this._commands.find((candidate) => candidate.name === match[1]);
    if (!command) {
      this._onError(new Error(t("slash.unsupported", { name: match[1] })));
      return true;
    }
    const argument = match[2]?.trim() || null;
    if (command.name === "rename" && this._onRename) {
      this.close();
      this._setInput("");
      this._onRename(argument);
      return true;
    }
    if (command.action === "argument" && !argument) {
      this._setInput(`/${command.name} `);
      this.close();
      return true;
    }
    if (command.action === "confirm" && !confirmCommand(command)) {
      return true;
    }
    await this._execute(command, null, argument);
    return true;
  }

  _renderCommands(commands, includeActions = false) {
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "slash-heading";
    heading.textContent = t("slash.heading");
    fragment.append(heading);

    const actionButtons = includeActions ? this._actions.map(action => {
      const button = commandButton(action.label, action.description);
      button.disabled = action.disabled?.() === true;
      button.addEventListener("click", () => { this.close(); action.onSelect(); });
      fragment.append(button);
      return button;
    }) : [];
    const buttons = commands.map((command) => {
      const button = commandButton(`/${command.name}`, localize(command.description));
      button.addEventListener("click", () => void this._chooseCommand(command));
      fragment.append(button);
      return button;
    });
    if (!buttons.length) {
      const empty = document.createElement("p");
      empty.className = "slash-empty";
      empty.textContent = t("slash.noMatch");
      fragment.append(empty);
    }
    this._show(fragment, [...actionButtons, ...buttons]);
  }

  async _chooseCommand(command) {
    if (command.name === "rename" && this._onRename) {
      const fromButton = this._fromButton;
      this.close();
      if (!fromButton) this._setInput("");
      this._onRename();
      return;
    }
    if (command.action === "argument") {
      this._setInput(`/${command.name} `);
      this.close();
      return;
    }
    if (command.action === "confirm" && !confirmCommand(command)) return;
    await this._execute(command, null, null);
  }

  async _execute(command, option, argument, clearInput = !this._fromButton) {
    await this._withBusy(async () => {
      this.close();
      if (clearInput) this._setInput("");
      else this._input.focus();
      const result = await this._request("command.run", {
        command: command.name,
        option,
        argument,
      });
      this._onResult(result);
    });
  }

  async _withBusy(action, disableComposer = true) {
    if (this._busy) return;
    this._busy = true;
    if (disableComposer) this._onBusy(true);
    try {
      await action();
    } catch (error) {
      this._onError(error);
    } finally {
      this._busy = false;
      if (disableComposer) this._onBusy(false);
    }
  }

  _show(fragment, buttons) {
    this._element.replaceChildren(fragment);
    this._element.hidden = false;
    this._button?.setAttribute("aria-expanded", String(this._fromButton));
    this._visibleItems = buttons;
    this._selectedIndex = buttons.findIndex((button) => !button.disabled);
    this._updateSelection();
  }

  /** Keyboard selection skips unavailable items so highlight order matches visual order. */
  _moveSelection(direction) {
    const total = this._visibleItems.length;
    for (let step = 1; step <= total; step += 1) {
      const index = (this._selectedIndex + direction * step + total * step) % total;
      if (!this._visibleItems[index]?.disabled) {
        this._selectedIndex = index;
        break;
      }
    }
    this._updateSelection();
  }

  _updateSelection() {
    this._visibleItems.forEach((button, index) => {
      button.setAttribute("aria-selected", index === this._selectedIndex ? "true" : "false");
      button.tabIndex = index === this._selectedIndex ? 0 : -1;
    });
    const selected = this._visibleItems[this._selectedIndex];
    selected?.scrollIntoView({ block: "nearest" });
    if (this._fromButton) selected?.focus();
  }

  _setInput(value) {
    this._input.value = value;
    this._onInputChanged();
    this._input.focus();
  }
}

window.SlashCommandMenu = SlashCommandMenu;

function commandButton(label, description) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "slash-item";
  button.setAttribute("role", "option");
  const name = document.createElement("strong");
  name.textContent = label;
  const detail = document.createElement("span");
  detail.textContent = description;
  button.append(name, detail);
  return button;
}

function confirmCommand(command) {
  const message = localize(command.confirmation) || t("slash.confirm", { name: command.name });
  return window.confirm(message);
}
