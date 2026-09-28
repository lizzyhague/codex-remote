import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserPathStreamRedactor,
  redactHostPaths,
  redactKnownAttachmentPaths,
  redactKnownAttachmentPathsDeep,
  redactPublicText,
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

test("replaces form, lowercase-percent, unicode-JSON and file URL variants", () => {
  const complex = {
    ...mapping,
    originalName: "秘密 note.txt",
    path: "/home/example/My Projects/秘密 note.txt",
  };
  const encoded = encodeURIComponent(complex.path);
  let escapeIndex = 0;
  const mixedCasePercent = encoded.replace(/%[0-9A-F]{2}/gu, (escape) => {
    escapeIndex += 1;
    return escapeIndex % 2 === 0 ? escape.toLowerCase() : escape;
  });
  const variants = [
    new URLSearchParams({ path: complex.path }).toString(),
    encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()),
    mixedCasePercent,
    complex.path.replace("秘密", "\\u79d8\\u5bc6"),
    complex.path.replace("秘密", "\\u79D8\\u5BC6").replaceAll("/", "\\/"),
    `file://${encodeURI(complex.path)}`,
    encodeURIComponent(`file://${complex.path}`),
  ];

  for (const variant of variants) {
    const redacted = redactKnownAttachmentPaths(variant, [complex]);
    assert.equal(redacted.includes("home"), false, variant);
    assert.equal(redacted.includes("example"), false, variant);
    assert.ok(redacted.includes("附件：秘密 note.txt"), variant);
  }
});

test("hides unknown host paths while preserving URLs and relative project paths", () => {
  const source = [
    "项目入口是 src/server/main.ts，接口是 /api/v1。",
    "文档：https://example.com/docs/setup/file.html",
    "读取 \"/home/example-user/My Projects/中文项目/秘密 note.txt\"。",
    "另见 file:///Users/example-user/private/report.pdf。",
  ].join("\n");
  const redacted = redactHostPaths(source);

  assert.ok(redacted.includes("src/server/main.ts"));
  assert.ok(redacted.includes("/api/v1"));
  assert.ok(redacted.includes("https://example.com/docs/setup/file.html"));
  assert.equal(redacted.includes("/home/example-user"), false);
  assert.equal(redacted.includes("/Users/example-user"), false);
  assert.ok(redacted.includes("‹主机路径›"));
});

test("redacts only the absolute-path span inside ordinary prose", () => {
  assert.equal(
    redactHostPaths("请读取 /home/example-user/My Projects/秘密 note.txt 后继续检查 /api/v1"),
    "请读取 ‹主机路径› 后继续检查 /api/v1",
  );
});

test("public text prefers an attachment label and hides other host paths", () => {
  const redacted = redactPublicText(
    `${mapping.path}\n/home/private/project/secret.txt`,
    [mapping],
  );
  assert.equal(redacted, "附件：报告.pdf\n‹主机路径›");
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
  const redactor = new BrowserPathStreamRedactor([mapping]);
  const prefix = mapping.path.slice(0, 18);
  const rest = mapping.path.slice(18);
  assert.equal(redactor.push(`看 ${prefix}`), "看 ");
  assert.equal(redactor.push(rest), "附件：报告.pdf");
  assert.equal(redactor.flush(), "");
});

test("holds and redacts an unknown host path split across deltas", () => {
  const redactor = new BrowserPathStreamRedactor();
  assert.equal(redactor.push("读取 /home/private"), "读取 ");
  const completed = redactor.push("/project/秘密 note.txt\n继续");
  assert.equal(completed, "‹主机路径›\n继续");
  assert.equal(redactor.flush(), "");
});

test("holds a split form-encoded attachment path", () => {
  const complex = {
    ...mapping,
    path: "/home/example/My Projects/秘密 note.txt",
  };
  const encoded = new URLSearchParams({ path: complex.path }).toString();
  const split = encoded.indexOf("%E7");
  const redactor = new BrowserPathStreamRedactor([complex]);
  assert.equal(redactor.push(encoded.slice(0, split)), "path=");
  assert.equal(redactor.push(`${encoded.slice(split)}\n`), "附件：报告.pdf\n");
  assert.equal(redactor.flush(), "");
});

test("streaming leaves relative paths and HTTP URLs intact", () => {
  const redactor = new BrowserPathStreamRedactor();
  const source = "src/server/main.ts https://example.com/docs/setup\n";
  assert.equal(redactor.push(source), source);
  assert.equal(redactor.flush(), "");
});

test("flushes remaining text without duplicating or dropping it", () => {
  const redactor = new BrowserPathStreamRedactor([mapping]);
  assert.equal(redactor.push("普通文字"), "普通文字");
  assert.equal(redactor.flush(), "");
  const again = new BrowserPathStreamRedactor([mapping]);
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
