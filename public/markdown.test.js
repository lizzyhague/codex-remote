import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdown, sanitizeHref, tokenizeInline } from "./markdown.js";

test("parses common chat markdown including tables", () => {
  const blocks = parseMarkdown(`
# 标题

普通 **粗体** 和 \`代码\`。

- 第一项
- [ ] 任务列表仍是文字

> 引用

| 名称 | 状态 | 数量 |
| :--- | :---: | ---: |
| A | **完成** | 2 |

\`\`\`js
const value = "<safe>";
\`\`\`
`);

  assert.deepEqual(blocks.map((block) => block.type), [
    "heading",
    "paragraph",
    "list",
    "blockquote",
    "table",
    "code",
  ]);
  assert.deepEqual(blocks[4]?.alignments, ["left", "center", "right"]);
  assert.deepEqual(blocks[4]?.rows, [["A", "**完成**", "2"]]);
  assert.equal(blocks[2]?.items[1], "[ ] 任务列表仍是文字");
  assert.equal(blocks[5]?.text, 'const value = "<safe>";');
});

test("keeps html as text and rejects unsafe links", () => {
  const tokens = tokenizeInline('<script>alert(1)</script> ![图](https://example.com/a.png)');
  assert.equal(tokens[0]?.type, "text");
  assert.equal(tokens[0]?.text, "<script>alert(1)</script> ");
  assert.equal(tokens[1]?.type, "imageLink");
  assert.equal(sanitizeHref("javascript:alert(1)"), null);
  assert.equal(sanitizeHref("data:text/html,test"), null);
  assert.equal(sanitizeHref("\u0001javascript:alert(1)"), null);
  assert.equal(sanitizeHref("java\tscript:alert(1)"), null);
  assert.equal(sanitizeHref("//example.com"), null);
  assert.equal(sanitizeHref("https://example.com"), "https://example.com");
  assert.equal(sanitizeHref("/docs/page"), "/docs/page");
});
