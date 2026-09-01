import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdown, renderMarkdown, sanitizeHref, tokenizeInline } from "./markdown.js";

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

test("renders a copy button that copies the complete fenced code block", async () => {
  let copiedText = null;
  let resetFeedback = null;
  const ownerDocument = createRecordingDocument({
    async writeText(text) {
      copiedText = text;
    },
  }, (callback) => {
    resetFeedback = callback;
    return 1;
  });

  const root = renderMarkdown("```js\nconst first = 1;\nconst second = 2;\n```", ownerDocument);
  const wrapper = root.children[0];
  const button = wrapper.children[0];
  const code = wrapper.children[1].children[0];

  assert.equal(wrapper.className, "markdown-code-block");
  assert.equal(button.className, "markdown-code-copy");
  assert.equal(button.attributes["aria-label"], "复制代码");
  assert.equal(code.dataset.language, "js");
  await button.listeners.click();
  assert.equal(copiedText, "const first = 1;\nconst second = 2;");
  assert.equal(button.textContent, "已复制 ✓");

  resetFeedback();
  assert.equal(button.textContent, "复制");
});

function createRecordingDocument(clipboard, setTimeout) {
  const ownerDocument = {
    defaultView: {
      navigator: { clipboard },
      clearTimeout() {},
      setTimeout,
    },
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        attributes: {},
        children: [],
        className: "",
        dataset: {},
        listeners: {},
        textContent: "",
        append(...children) {
          this.children.push(...children);
        },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        addEventListener(type, listener) {
          this.listeners[type] = listener;
        },
      };
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: text };
    },
  };
  return ownerDocument;
}
