import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("visible colors are declared in the color module", () => {
  const rootEnd = styles.indexOf("\n}");
  assert.notEqual(rootEnd, -1);
  const light = ':root[data-theme="light"]';
  const lightStart = styles.indexOf(light, rootEnd);
  assert.ok(lightStart !== -1 && styles.slice(rootEnd + 2, lightStart).trim().startsWith("/*"));
  const moduleEnd = styles.indexOf("}", lightStart);
  assert.match(
    styles.slice(lightStart, moduleEnd),
    /--theme:\s*color-mix\(in srgb, color-mix\(in srgb, var\(--neutral\) var\(--mix-text\), var\(--ink\)\) 30%, #a7f3d0\);/u,
  );
  const rules = styles.slice(moduleEnd + 1).replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(rules, /#[\da-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(/iu);
});
