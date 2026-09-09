import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPrivateAttachmentPathsBlock,
  parsePrivateAttachmentPaths,
  stripPrivateAttachmentPaths,
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

test("round-trips attachment metadata through the versioned block", () => {
  const block = formatPrivateAttachmentPathsBlock(sample);
  assert.deepEqual(parsePrivateAttachmentPaths(block), sample);
  assert.equal(stripPrivateAttachmentPaths(`请查看\n\n${block}`), "请查看");
});

test("does not swallow user text that only mentions the start marker", () => {
  const text = "标记叫 [AI_REMOTE_PRIVATE_ATTACHMENT_PATHS_V1] ，后面还有正文。";
  assert.equal(stripPrivateAttachmentPaths(text), text);
  assert.deepEqual(parsePrivateAttachmentPaths(text), []);
});

test("strips a complete block even when user text discusses the markers", () => {
  const block = formatPrivateAttachmentPathsBlock(sample);
  const text = `开始标记是 [AI_REMOTE_PRIVATE_ATTACHMENT_PATHS_V1]\n${block}\n讨论结束`;
  assert.equal(
    stripPrivateAttachmentPaths(text),
    "开始标记是 [AI_REMOTE_PRIVATE_ATTACHMENT_PATHS_V1]\n讨论结束",
  );
});
