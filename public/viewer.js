import { renderMarkdown } from "./markdown.js";

const status = document.getElementById("viewer-status");
const content = document.getElementById("file-content");
const login = document.getElementById("viewer-login");
const params = new URLSearchParams(location.search);
const filePath = params.get("path");

async function loadFile() {
  if (!filePath || params.getAll("path").length !== 1) {
    throw new Error("链接缺少有效的文件路径。");
  }
  const name = filePath.split("/").pop() || filePath;
  document.getElementById("file-name").textContent = name;
  document.title = `${name} · Codex Remote`;
  const raw = `/raw?${new URLSearchParams({ path: filePath })}`;
  const markdown = /\.md$/i.test(filePath);
  const response = await fetch(raw, { method: markdown ? "GET" : "HEAD", cache: "no-store" });
  if (response.status === 401) {
    status.textContent = "请先登录 Codex Remote，再查看此文件。";
    login.href = `/?${new URLSearchParams({ returnTo: location.pathname + location.search })}`;
    login.hidden = false;
    return;
  }
  if (!response.ok) {
    throw new Error(response.status === 404
      ? "文件不存在或不允许查看。"
      : "文件读取失败，请稍后刷新重试。");
  }
  if (markdown) {
    content.append(renderMarkdown(await response.text()));
  } else if (response.headers.get("content-type")?.startsWith("image/")) {
    const image = document.createElement("img");
    image.alt = name;
    image.className = "viewer-image";
    image.addEventListener("error", () => {
      status.hidden = false;
      status.textContent = "图片无法显示，文件可能已变化，请刷新重试。";
    });
    image.src = raw;
    content.append(image);
  } else {
    throw new Error("此文件类型不支持查看。");
  }
  status.hidden = true;
}

void loadFile().catch((error) => {
  status.textContent = error instanceof Error ? error.message : "无法读取文件。";
});
