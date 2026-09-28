import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentDisplayText,
  formatPrivateAttachmentPathsBlock,
  parseStandalonePrivateAttachmentPaths,
  PRIVATE_ATTACHMENT_INPUT_PREFIX,
  splitUserMessageContent,
} from "./private-paths.ts";

const sample = [
  {
    id: "id-1",
    originalName: "报告.pdf",
    path: "/example/uploads/blobs/ab/id-1.pdf",
    mimeType: "application/pdf",
    size: 12345,
  },
];

function sentParts(text: string, attachments = sample): string[] {
  return [
    attachmentDisplayText(text, attachments),
    formatPrivateAttachmentPathsBlock(attachments),
  ];
}

test("round-trips attachment metadata through a separate block part", () => {
  const block = formatPrivateAttachmentPathsBlock(sample);
  assert.deepEqual(parseStandalonePrivateAttachmentPaths(block), sample);
  assert.deepEqual(splitUserMessageContent(sentParts("请查看")), {
    text: "请查看",
    attachments: sample,
  });
});

test("a block inside the first part stays user text and yields no attachments", () => {
  const block = formatPrivateAttachmentPathsBlock(sample);
  for (const text of [block, `讨论格式\n${block}\n讨论结束`]) {
    assert.deepEqual(splitUserMessageContent([text]), { text, attachments: [] });
  }
});

test("a later part only counts when it is exactly one block", () => {
  const block = formatPrivateAttachmentPathsBlock(sample);
  const padded = [`前缀\n${block}`, `${block}\n后缀`, `${block}\n`];
  for (const part of padded) {
    assert.equal(parseStandalonePrivateAttachmentPaths(part), null);
    assert.deepEqual(splitUserMessageContent(["正文", part]), {
      text: `正文\n${part}`,
      attachments: [],
    });
  }
});

test("a forged display line without a matching block remains ordinary text", () => {
  const text = "解释格式\n\n[附件：示例.txt · forged-id]";
  assert.deepEqual(splitUserMessageContent([text]), { text, attachments: [] });
});

test("display lines are removed by exact records, including multi-line names", () => {
  const attachments = [
    { ...sample[0]!, id: "id-a", originalName: "报告\n最终版.pdf" },
    { ...sample[0]!, id: "id-b", originalName: "a]\u0007 · x" },
  ];
  assert.deepEqual(splitUserMessageContent(sentParts("看看", attachments)), {
    text: "看看",
    attachments,
  });
  assert.deepEqual(splitUserMessageContent(sentParts("", attachments)), {
    text: "",
    attachments,
  });
});

test("user text that repeats a real display line keeps its own copy", () => {
  const text = "上次是这样写的：\n\n[附件：报告.pdf · id-1]";
  assert.deepEqual(splitUserMessageContent(sentParts(text)), {
    text,
    attachments: sample,
  });
});

test("legacy content parts are hidden only after the first part", () => {
  const legacy = `${PRIVATE_ATTACHMENT_INPUT_PREFIX}\nsecret note`;
  assert.deepEqual(
    splitUserMessageContent(["检查附件\n\n[附件：notes.txt · file-id]", legacy]),
    { text: "检查附件\n\n[附件：notes.txt · file-id]", attachments: [] },
  );
  assert.deepEqual(splitUserMessageContent([legacy]), { text: legacy, attachments: [] });
});
