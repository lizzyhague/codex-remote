import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { englishText, hasText, isLocalText, localText } from "./local-text.ts";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  }));
  return files.flat();
}

test("every key the backend sends exists in public/strings.js", async () => {
  const sources = [...await sourceFiles(SOURCE_ROOT), fileURLToPath(new URL("../../public/mcp-form.js", import.meta.url))];
  // Any dotted key literal on a line that builds interface text, including both arms of a ternary.
  const textLine = /\blocalText\(|\binvalid\(/u;
  const keyLiteral = /"([a-z]+\.[A-Za-z]+)"/gu;
  const requestTypes = /^(?:approval|attachment|command|commands|history|interaction|message|projects|session|sessions|settings|task)\.(?:answer|ticket|options|run|list|older|send|mark|metrics|rename|resume|start|mutate|get|models|permissions|update|stop)$/u;
  let checked = 0;
  for (const file of sources) {
    const lines = (await readFile(file, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      // A ternary may put its second key on the next line.
      if (!textLine.test(line) && !textLine.test(lines[index - 1] ?? "")) continue;
      for (const match of line.matchAll(keyLiteral)) {
        if (requestTypes.test(match[1]!)) continue;
        assert.ok(hasText(match[1]!), `${path.relative(SOURCE_ROOT, file)}:${index + 1}: ${match[1]}`);
        checked += 1;
      }
    }
  }
  for (const access of ["read", "write", "deny"]) assert.ok(hasText(`approval.${access}`), access);
  assert.ok(checked > 100, `only ${checked} keys found`);
});

test("englishText fills parameters, nested text and plural forms", () => {
  assert.equal(
    englishText(localText("approval.read", { scope: localText("approval.projectSubdir", { path: "src" }) })),
    "Read: project directory/src",
  );
  assert.equal(englishText(localText("metrics.hours", { count: 1 })), "1 hour");
  assert.equal(englishText(localText("metrics.hours", { count: 5 })), "5 hours");
  assert.equal(englishText(localText("missing.key")), "missing.key");
});

test("isLocalText accepts nested parameters and rejects other shapes", () => {
  assert.equal(isLocalText(localText("approval.read", { scope: localText("approval.root") })), true);
  assert.equal(isLocalText({ key: "x", params: { value: [] } }), false);
  assert.equal(isLocalText("text"), false);
});
