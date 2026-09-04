export class SlashCommandMenu {
  constructor(options) {
    this._input = options.input;
    this._element = options.element;
    this._request = options.request;
    this._onResult = options.onResult;
    this._onError = options.onError;
    this._onBusy = options.onBusy;
    this._onInputChanged = options.onInputChanged;
    this._commands = [];
    this._visibleItems = [];
    this._selectedIndex = 0;
    this._busy = false;
  }

  async load() {
    try {
      const data = await this._request("commands.list");
      this._commands = Array.isArray(data?.commands) ? data.commands : [];
      this.handleInput();
    } catch (error) {
      this._onError(error);
    }
  }

  close() {
    this._element.hidden = true;
    this._element.replaceChildren();
    this._visibleItems = [];
    this._selectedIndex = 0;
  }

  handleInput() {
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
      this.close();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this._moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return true;
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
    const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) {
      this._onError(new Error("无法识别这个斜杠命令。输入 / 可以查看列表。"));
      return true;
    }
    const command = this._commands.find((candidate) => candidate.name === match[1]);
    if (!command) {
      this._onError(new Error(`不支持 /${match[1]}。输入 / 可以查看列表。`));
      return true;
    }
    const argument = match[2]?.trim() || null;
    if (command.action === "options" && !argument) {
      await this._openOptions(command);
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
    await this._execute(
      command,
      command.action === "options" ? argument : null,
      command.action === "options" ? null : argument,
    );
    return true;
  }

  async runShortcut(name, option = null) {
    const command = this._commands.find((candidate) => candidate.name === name);
    if (!command) {
      this._onError(new Error(`快捷命令 /${name} 当前不可用。`));
      return;
    }
    if (command.action === "confirm" && !confirmCommand(command)) return;
    await this._execute(command, option, null, false);
  }

  _renderCommands(commands) {
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "slash-heading";
    heading.textContent = "Codex 命令";
    fragment.append(heading);

    const buttons = commands.map((command) => {
      const button = commandButton(`/${command.name}`, command.description);
      button.addEventListener("click", () => void this._chooseCommand(command));
      fragment.append(button);
      return button;
    });
    if (!buttons.length) {
      const empty = document.createElement("p");
      empty.className = "slash-empty";
      empty.textContent = "没有匹配的命令。";
      fragment.append(empty);
    }
    this._show(fragment, buttons);
  }

  async _chooseCommand(command) {
    if (command.action === "options") {
      await this._openOptions(command);
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

  async _openOptions(command) {
    await this._withBusy(async () => {
      const data = await this._request("command.options", { command: command.name });
      this._renderOptions(command, data);
    }, false);
  }

  _renderOptions(command, data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    this._renderOptionLevel(
      data?.title || `/${command.name}`,
      items,
      () => {
        this._setInput("/");
        this.handleInput();
      },
      (item) => {
        if (Array.isArray(item.items) && item.items.length) {
          this._renderEffortOptions(command, item, data);
          return;
        }
        void this._execute(command, item.id, null);
      },
    );
  }

  _renderEffortOptions(command, model, parentData) {
    const modelLabel = typeof model.label === "string"
      ? model.label.replace(/^✓\s*/, "")
      : model.id;
    this._renderOptionLevel(
      `${modelLabel} · 选择思考强度`,
      model.items,
      () => this._renderOptions(command, parentData),
      (effort) => void this._execute(command, model.id, effort.id),
    );
  }

  _renderOptionLevel(titleText, items, onBack, onSelect) {
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "slash-heading";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "slash-back";
    back.textContent = "‹ 返回";
    back.addEventListener("click", onBack);
    const title = document.createElement("strong");
    title.textContent = titleText;
    heading.append(back, title);
    fragment.append(heading);

    const buttons = items.map((item) => {
      const button = commandButton(item.label || item.id, item.description || "");
      button.disabled = item.disabled === true;
      button.dataset.danger = item.danger === true ? "true" : "false";
      button.addEventListener("click", () => {
        if (item.danger === true && !window.confirm(
          "完全访问会让 Codex 不受项目沙箱限制地操作主机。确定只为当前会话选择吗？",
        )) return;
        onSelect(item);
      });
      fragment.append(button);
      return button;
    });
    this._show(fragment, buttons);
  }

  async _execute(command, option, argument, clearInput = true) {
    await this._withBusy(async () => {
      this.close();
      if (clearInput) this._setInput("");
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
    this._visibleItems = buttons;
    this._selectedIndex = Math.max(0, buttons.findIndex((button) => !button.disabled));
    this._updateSelection();
  }

  /** 键盘选择跳过不可用项，让高亮顺序和看到的顺序一致。 */
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
    });
    this._visibleItems[this._selectedIndex]?.scrollIntoView({ block: "nearest" });
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
  const message = typeof command.confirmation === "string" && command.confirmation
    ? command.confirmation
    : `确定执行 /${command.name} 吗？`;
  return window.confirm(message);
}
