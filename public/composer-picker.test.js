import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [app, styles] = await Promise.all([
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

test("the picker reads the selected flag instead of the label text", () => {
  assert.equal(app.includes("✓"), false, "选中状态不该再从标签文字里判断");
  assert.match(app, /find\(item => item\.selected\)/u);
  assert.match(app, /aria-selected", String\(item\.selected === true\)/u);
});

test("the check mark is drawn from the selected state", () => {
  assert.match(
    styles,
    /\.composer-picker-option\[aria-selected="true"\] strong::before \{\s*content: "✓ ";/u,
  );
});

const FOCUS_TARGET = app.slice(
  app.indexOf("function pickerFocusTarget(menu)"),
  app.indexOf("function renderComposerPicker("),
);

function fakeMenu(present) {
  const asked = [];
  return {
    asked,
    querySelector(selector) {
      asked.push(selector);
      return present.includes(selector) ? { selector } : null;
    },
  };
}

function focusTargetFor(present) {
  const context = vm.createContext({});
  vm.runInContext(FOCUS_TARGET, context);
  const menu = fakeMenu(present);
  return { chosen: context.pickerFocusTarget(menu), asked: menu.asked };
}

const CHECKED = 'button[aria-selected="true"]:not(:disabled)';
const OPTION = "button.composer-picker-option:not(:disabled)";
const ANY = "button:not(:disabled)";

test("the open menu focuses the checked option, not whatever comes first", () => {
  const { chosen, asked } = focusTargetFor([CHECKED, OPTION, ANY]);
  assert.equal(chosen.selector, CHECKED);
  assert.deepEqual(asked, [CHECKED]);
});

test("with nothing checked the focus goes to an option rather than the back button", () => {
  const { chosen } = focusTargetFor([OPTION, ANY]);
  assert.equal(chosen.selector, OPTION);
});

test("a menu whose options are all disabled still gives the keyboard somewhere to land", () => {
  const { chosen } = focusTargetFor([ANY]);
  assert.equal(chosen.selector, ANY);
});
