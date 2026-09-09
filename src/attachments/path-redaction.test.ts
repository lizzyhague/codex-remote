import assert from "node:assert/strict";
import test from "node:test";

import {
  AttachmentPathStreamRedactor,
  redactKnownAttachmentPaths,
  redactKnownAttachmentPathsDeep,
} from "./path-redaction.ts";

const mapping = {
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  originalName: "报告.pdf",
  path: "/example/uploads/blobs/ab/7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf",
};

test("replaces raw, URL-encoded and JSON-escaped known paths", () => {
  const encoded = encodeURIComponent(mapping.path);
  const jsonInner = JSON.stringify(mapping.path).slice(1, -1);
  const source = [
    `打开 ${mapping.path}`,
    `/view?path=${encoded}`,
    `{"file_path":"${jsonInner}"}`,
  ].join("\n");
  const redacted = redactKnownAttachmentPaths(source, [mapping]);
  assert.equal(redacted.includes(mapping.path), false);
  assert.equal(redacted.includes(encoded), false);
  assert.ok(redacted.includes("附件：报告.pdf"));
});

test("adds a short id when two attachments share a name", () => {
  const other = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    originalName: "报告.pdf",
    path: "/example/uploads/blobs/cd/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf",
  };
  const redacted = redactKnownAttachmentPaths(`${mapping.path} ${other.path}`, [mapping, other]);
  assert.ok(redacted.includes("附件：报告.pdf (7c9e6679)"));
  assert.ok(redacted.includes("附件：报告.pdf (aaaaaaaa)"));
});

test("holds a split path across deltas and does not emit the raw address", () => {
  const redactor = new AttachmentPathStreamRedactor([mapping]);
  const prefix = mapping.path.slice(0, 18);
  const rest = mapping.path.slice(18);
  assert.equal(redactor.push(`看 ${prefix}`), "看 ");
  assert.equal(redactor.push(rest), "附件：报告.pdf");
  assert.equal(redactor.flush(), "");
});

test("flushes remaining text without duplicating or dropping it", () => {
  const redactor = new AttachmentPathStreamRedactor([mapping]);
  assert.equal(redactor.push("普通文字"), "普通文字");
  assert.equal(redactor.flush(), "");
  const again = new AttachmentPathStreamRedactor([mapping]);
  const held = again.push(mapping.path.slice(0, 20));
  assert.equal(held, "");
  const flushed = again.flush();
  assert.equal(flushed.includes(mapping.path.slice(0, 20)), false);
  assert.ok(flushed.includes("附件：报告.pdf") || flushed === "附件");
});

test("redacts nested display copies without mutating the original", () => {
  const original = {
    reason: `打开 ${mapping.path}`,
    nested: { href: mapping.path },
  };
  const redacted = redactKnownAttachmentPathsDeep(original, [mapping]);
  assert.equal(original.nested.href, mapping.path);
  assert.equal(redacted.nested.href.includes(mapping.path), false);
  assert.ok(redacted.reason.includes("附件：报告.pdf"));
});
