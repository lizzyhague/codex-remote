import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
