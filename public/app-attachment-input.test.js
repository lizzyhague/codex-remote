import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { t } from "./i18n.test-support.js";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");
const start = source.indexOf("function canAddAttachments()");
const end = source.indexOf('elements.messageInput.addEventListener("input"', start);
assert.ok(start >= 0 && end > start);

function target() {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  return {
    disabled: false, textContent: "", value: "", listeners, classes, attributes,
    addEventListener(name, handler) { listeners[name] = handler; },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; },
    contains(node) { return node === this || node === this.child; },
  };
}
function harness() {
  const elements = Object.fromEntries(["composer", "messageInput", "attachmentInput", "commandMenuButton"].map((key) => [key, target()]));
  const state = { sessionId: "session", projectId: "project", pendingAttachments: [] };
  const notices = [];
  let nextId = 1;
  const uploads = [];
  const document = target();
  const window = target();
  vm.runInNewContext(source.slice(source.indexOf('elements.attachmentInput.addEventListener("change"'), start) + source.slice(start, end) + source.slice(source.indexOf("async function uploadFiles("), source.indexOf("async function startUpload(")), {
    elements, state, document, window, t, File, Date,
    MAX_MESSAGE_ATTACHMENTS: 100, MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
    TEMPORARY_WARNING: {},
    createClientMessageId: () => String(nextId++),
    showNotice: (text) => notices.push(text),
    renderAttachmentList() {}, updateControls() {},
    startUpload(draft) { uploads.push({ draft, file: draft.file }); },
  });
  function emit(where, name, data = {}) {
    const event = { prevented: false, preventDefault() { this.prevented = true; }, ...data };
    where.listeners[name](event);
    return event;
  }
  function drop(items) {
    return emit(elements.composer, "drop", { dataTransfer: { items } });
  }
  return { elements, state, uploads, notices, document, window, emit, drop };
}
const fileItem = (file) => ({ kind: "file", getAsFile: () => file });
const file = (name = "a.txt") => new File(["hello"], name, { type: "text/plain" });

test("drops multiple files and skips directories in the same batch", () => {
  const h = harness();
  h.drop([fileItem(file()), { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile() { throw Error("directory read"); } }, fileItem(file("b.txt"))]);
  assert.deepEqual(h.uploads.map(({ file }) => file.name), ["a.txt", "b.txt"]);
  assert.equal(h.notices.at(-1), t("attachment.noFolders"));
});
test("rejects links and prevents navigation outside the composer", () => {
  const h = harness();
  assert.ok(h.drop([{ kind: "string", type: "text/uri-list" }]).prevented);
  assert.equal(h.notices.at(-1), t("attachment.noWebContent"));
  assert.equal(h.uploads.length, 0);
  assert.ok(h.emit(h.document, "drop").prevented);
});
test("pasted screenshot names include a timestamp and sequence while other names survive", () => {
  const h = harness();
  const image = new File(["png"], "image.png", { type: "image/png", lastModified: 42 });
  const event = h.emit(h.elements.messageInput, "paste", { clipboardData: { files: [image, image, file("notes.txt")] } });
  assert.ok(event.prevented);
  assert.match(h.uploads[0].file.name, /^screenshot-\d{8}-\d{6}-1\.png$/);
  assert.match(h.uploads[1].file.name, /-2\.png$/);
  assert.equal(h.uploads[0].file.lastModified, 42);
  assert.equal(h.uploads[2].file.name, "notes.txt");
});
test("plain text paste keeps the browser default", () => {
  const h = harness();
  assert.equal(h.emit(h.elements.messageInput, "paste", { clipboardData: { files: [] } }).prevented, false);
  assert.equal(h.uploads.length, 0);
});
test("all entry points enforce the attachment count before starting uploads", () => {
  for (const entry of ["drop", "paste", "picker"]) {
    const h = harness();
    h.state.pendingAttachments = Array.from({ length: 99 }, () => ({}));
    const files = [file(), file("b.txt")];
    if (entry === "drop") h.drop(files.map(fileItem));
    if (entry === "paste") h.emit(h.elements.messageInput, "paste", { clipboardData: { files } });
    if (entry === "picker") { h.elements.attachmentInput.files = files; h.emit(h.elements.attachmentInput, "change"); }
    assert.equal(h.state.pendingAttachments.length, 100);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.notices.at(-1), t("attachment.limitPartial", { count: 100, available: 1 }));
  }
});
test("oversized files fail locally before uploads start", () => {
  const h = harness();
  h.drop([fileItem({ name: "big.bin", size: 26 * 1024 * 1024 }), fileItem(file())]);
  assert.equal(h.state.pendingAttachments[0].status, "failed");
  assert.equal(h.state.pendingAttachments[0].statusKey, "attachment.tooLarge");
  assert.equal(h.uploads.length, 1);
});
test("drag highlight survives child transitions and clears on leaving or cancelling", () => {
  const h = harness();
  const composer = h.elements.composer;
  composer.child = {};
  const enter = () => h.emit(composer, "dragover", { dataTransfer: { types: ["Files"] } });
  enter();
  assert.ok(composer.classes.has("file-drag-over"));
  h.emit(composer, "dragleave", { relatedTarget: composer.child });
  assert.ok(composer.classes.has("file-drag-over"));
  h.emit(composer, "dragleave", { relatedTarget: null });
  assert.equal(composer.classes.size, 0);
  enter();
  h.emit(h.window, "blur");
  assert.equal(composer.classes.size, 0);
});
test("disabled plus menu disables file drag and paste but leaves default paste intact", () => {
  const h = harness();
  h.elements.commandMenuButton.disabled = true;
  h.emit(h.elements.composer, "dragover", { dataTransfer: { types: ["Files"] } });
  h.drop([fileItem(file())]);
  const paste = h.emit(h.elements.messageInput, "paste", { clipboardData: { files: [file()] } });
  assert.equal(h.elements.composer.classes.size, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(paste.prevented, false);
});
test("directory and count warnings appear together in one notice", () => {
  const h = harness();
  h.state.pendingAttachments = Array.from({ length: 100 }, () => ({}));
  h.drop([fileItem(file()), { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }]);
  assert.equal(h.notices.length, 1);
  assert.ok(h.notices[0].includes(t("attachment.noFolders")));
  assert.ok(h.notices[0].includes(t("attachment.limit", { count: 100 })));
  assert.equal(h.uploads.length, 0);
});
