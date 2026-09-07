import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openViewableFile } from "./files.ts";

test("file boundary accepts documents and images from configured roots only", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "codex-remote-files-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const firstRoot = path.join(temp, "first");
  const secondRoot = path.join(temp, "second");
  const outside = path.join(temp, "outside");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot), mkdir(outside)]);
  await mkdir(path.join(firstRoot, "directory.md"));
  await writeFile(path.join(outside, "outside.md"), "outside");
  await writeFile(path.join(firstRoot, ".env"), "private");
  await writeFile(path.join(firstRoot, "source.ts"), "code");
  await writeFile(path.join(firstRoot, "中文 # ? %.md"), "# 文档");
  await symlink(outside, path.join(firstRoot, "escape"));
  await symlink(path.join(firstRoot, ".env"), path.join(firstRoot, "secret.md"));
  await symlink(path.join(firstRoot, "中文 # ? %.md"), path.join(firstRoot, "alias.md"));
  const roots = [await realpath(firstRoot), await realpath(secondRoot)];

  for (const input of [
    "",
    "relative.md",
    path.join(firstRoot, "missing.md"),
    path.join(firstRoot, ".env"),
    path.join(firstRoot, "source.ts"),
    path.join(firstRoot, "directory.md"),
    path.join(firstRoot, "secret.md"),
    path.join(outside, "outside.md"),
    path.join(firstRoot, "escape", "outside.md"),
    `${firstRoot}/bad\0.md`,
  ]) {
    assert.equal(await openViewableFile(roots, input), null, input);
  }
  for (const input of [
    path.join(firstRoot, "中文 # ? %.md"),
    path.join(firstRoot, "alias.md"),
  ]) {
    const file = await openViewableFile(roots, input);
    assert.ok(file, input);
    try {
      assert.equal(file.contentType, "text/markdown; charset=utf-8");
      assert.equal(await file.handle.readFile("utf8"), "# 文档");
    } finally {
      await file.handle.close();
    }
  }
  for (const suffix of ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "PNG"]) {
    const image = path.join(secondRoot, `image.${suffix}`);
    await writeFile(image, "image");
    const file = await openViewableFile(roots, image);
    assert.ok(file, suffix);
    assert.match(file.contentType, /^image\//u);
    await file.handle.close();
  }
});

test("directory identity respects the filesystem's case behavior", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "codex-remote-file-case-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Root");
  await mkdir(root);
  await writeFile(path.join(root, "note.md"), "inside");
  const alternate = path.join(temp, "root");
  let insensitive = false;
  try {
    insensitive = await realpath(alternate) === await realpath(root);
  } catch {
    // 大小写敏感卷上这是另一个尚不存在的目录。
  }
  if (!insensitive) {
    await mkdir(alternate);
    await writeFile(path.join(alternate, "note.md"), "outside");
  }
  const file = await openViewableFile([await realpath(root)], path.join(alternate, "note.md"));
  if (insensitive) {
    assert.ok(file);
    assert.equal(await file.handle.readFile("utf8"), "inside");
    await file.handle.close();
  } else {
    assert.equal(file, null);
  }
});
