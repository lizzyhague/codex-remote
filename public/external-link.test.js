import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { sanitizeHref } from "./markdown.js";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
const context = vm.createContext({ sanitizeHref });
vm.runInContext(
  app.slice(
    app.indexOf("function externalLinkHref(value)"),
    app.indexOf("function addMcpFormFields("),
  ),
  context,
);
const { externalLinkHref } = context;

test("ordinary web addresses stay clickable", () => {
  assert.equal(externalLinkHref("https://example.com/oauth?x=1"), "https://example.com/oauth?x=1");
  assert.equal(externalLinkHref("http://127.0.0.1:8080/callback"), "http://127.0.0.1:8080/callback");
});

test("anything that is not a web address is refused a link", () => {
  for (
    const value of [
      "javascript:alert(1)",
      // 浏览器解析前会丢掉控制字符，所以这种写法也必须挡住。
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///home/someone/.ssh/id_ed25519",
      "//example.com/protocol-relative",
      "mailto:someone@example.com",
      "/relative/path",
      "",
      null,
      undefined,
      { toString: () => "https://example.com" },
    ]
  ) {
    assert.equal(externalLinkHref(value), null, `${String(value)} 不该被当成网页链接`);
  }
});

test("the MCP login card only links an address that passed the check", () => {
  const card = app.slice(app.indexOf("const loginHref = externalLinkHref(interaction.url);"));
  assert.match(card, /link\.href = loginHref;/u);
  assert.equal(card.includes("link.href = interaction.url"), false);
  // 没能打开的授权不该被回报成已完成。
  assert.match(card.slice(0, card.indexOf("} else {")), /canSubmit = false;/u);
});
