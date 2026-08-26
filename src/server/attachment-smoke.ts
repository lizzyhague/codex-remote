import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import WebSocket from "ws";

const baseUrl = process.env.CODEX_REMOTE_SMOKE_URL ?? "http://127.0.0.1:18787";
const token = process.env.CODEX_REMOTE_SMOKE_TOKEN ??
  "codex-remote-attachment-smoke-token";
const projectName = process.env.CODEX_REMOTE_SMOKE_PROJECT ?? "codex-remote";
const timeoutMs = 4 * 60 * 1_000;

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-remote-attachment-smoke-"));
  const socket = new SmokeSocket(webSocketUrl(baseUrl));
  let cleanupProjectId: string | null = null;
  let cleanupSessionId: string | null = null;
  try {
    const image = makeUiFixturePng();
    const note = Buffer.from("REMOTE_FILE_TOKEN=ORCHID-5824\n", "utf8");
    await Promise.all([
      writeFile(path.join(directory, "ui-fixture.png"), image),
      writeFile(path.join(directory, "note.txt"), note),
    ]);

    await socket.open();
    await socket.request("auth", { token });
    const projects = asArray((await socket.request("projects.list", {})).projects);
    const project = projects.map(asObject).find((entry) => entry?.name === projectName);
    if (typeof project?.id !== "string") {
      throw new Error(`项目列表中没有 ${projectName}。`);
    }
    cleanupProjectId = project.id;
    const opened = asObject(await socket.request("session.start", { projectId: project.id }));
    const session = asObject(opened?.session);
    if (typeof session?.id !== "string") throw new Error("新会话没有返回 ID。");
    cleanupSessionId = session.id;

    const imageAttachment = await uploadAttachment(socket, baseUrl, {
      name: "ui-fixture.png",
      mime: "image/png",
      bytes: image,
    });
    const noteAttachment = await uploadAttachment(socket, baseUrl, {
      name: "note.txt",
      mime: "text/plain",
      bytes: note,
    });

    const clientMessageId = randomUUID();
    const completion = socket.waitForTaskCompletion(clientMessageId, timeoutMs);
    const accepted = asObject(await socket.request("message.send", {
      clientMessageId,
      text: [
        "这是附件输入的自动冒烟测试。请查看图片和文本文件。",
        "只回复一行，依次写：图片中央的像素文字、彩色按钮的颜色和位置、文本文件等号后的值。",
        "第二项必须使用 COLOR_POSITION 格式，例如 RED_TOP_LEFT；三项用空格分隔。不要调用工具。",
      ].join("\n"),
      attachmentIds: [imageAttachment.id, noteAttachment.id],
    }));
    if (typeof accepted?.taskId !== "string") throw new Error("消息没有返回任务 ID。");
    socket.bindTask(clientMessageId, accepted.taskId);
    const answer = await completion;
    for (const expected of ["CODEX-7319", "GREEN_BOTTOM_RIGHT", "ORCHID-5824"]) {
      if (!answer.includes(expected)) {
        throw new Error(`Codex 的附件回答缺少 ${expected}：${answer}`);
      }
    }
    console.log(
      `附件端到端冒烟成功：图片 ${imageAttachment.id}，文件 ${noteAttachment.id}；` +
        "Codex 正确返回了图片文字、控件位置/颜色和文件内容。",
    );
  } finally {
    if (cleanupProjectId && cleanupSessionId) {
      await archiveSmokeSession(socket, cleanupProjectId, cleanupSessionId).catch((error: unknown) => {
        console.warn(`无法自动归档附件冒烟会话：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    socket.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function archiveSmokeSession(
  socket: SmokeSocket,
  projectId: string,
  sessionId: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await socket.request("sessions.mutate", {
        projectId,
        sessionIds: [sessionId],
        action: "archive",
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

type UploadFixture = { name: string; mime: string; bytes: Buffer };

async function uploadAttachment(
  socket: SmokeSocket,
  remoteUrl: string,
  fixture: UploadFixture,
): Promise<Record<string, unknown>> {
  const ticket = asObject(await socket.request("attachment.ticket.create", {
    originalName: fixture.name,
    declaredMime: fixture.mime,
    expectedSize: fixture.bytes.byteLength,
  }));
  if (typeof ticket?.ticket !== "string") throw new Error("没有收到上传票据。");
  const response = await fetch(new URL("/attachments/upload", remoteUrl), {
    method: "POST",
    headers: {
      "content-type": fixture.mime,
      "content-length": String(fixture.bytes.byteLength),
      "x-upload-ticket": ticket.ticket,
    },
    body: fixture.bytes,
  });
  const value = asObject(await response.json());
  if (!response.ok) {
    const error = asObject(value?.error);
    throw new Error(typeof error?.message === "string" ? error.message : "附件上传失败。");
  }
  const attachment = asObject(value?.attachment);
  if (typeof attachment?.id !== "string" || "path" in attachment) {
    throw new Error("上传响应缺少附件 ID 或错误地暴露了服务器路径。");
  }
  return attachment;
}

class SmokeSocket {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  readonly #taskAliases = new Map<string, string>();
  readonly #taskWaiters = new Map<string, {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    answers: string[];
  }>();

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.on("message", (data) => this.#receive(String(data)));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.once("open", resolve);
      this.#socket.once("error", reject);
    });
  }

  request(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#socket.send(JSON.stringify({ type, requestId, ...payload }));
    });
  }

  waitForTaskCompletion(clientMessageId: string, durationMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#taskWaiters.delete(clientMessageId);
        reject(new Error("等待附件冒烟任务完成超时。"));
      }, durationMs);
      this.#taskWaiters.set(clientMessageId, { resolve, reject, timer, answers: [] });
    });
  }

  bindTask(clientMessageId: string, taskId: string): void {
    const waiter = this.#taskWaiters.get(clientMessageId);
    if (!waiter) return;
    this.#taskAliases.set(taskId, clientMessageId);
  }

  close(): void {
    this.#socket.close();
    for (const pending of this.#pending.values()) pending.reject(new Error("冒烟连接已关闭。"));
    this.#pending.clear();
    for (const waiter of this.#taskWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("冒烟连接已关闭。"));
    }
    this.#taskWaiters.clear();
  }

  #receive(source: string): void {
    const message = asObject(JSON.parse(source));
    if (!message) return;
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.#pending.get(message.requestId);
      if (!pending) return;
      this.#pending.delete(message.requestId);
      if (message.ok === true) pending.resolve(asObject(message.data) ?? {});
      else {
        const error = asObject(message.error);
        pending.reject(new Error(typeof error?.message === "string" ? error.message : "请求失败。"));
      }
      return;
    }
    if (message.type !== "event") return;
    const event = asObject(message.event);
    if (!event || typeof event.taskId !== "string") return;
    const key = this.#taskAliases.get(event.taskId);
    const waiter = key ? this.#taskWaiters.get(key) : null;
    if (!waiter) return;
    if (event.type === "message.completed" && typeof event.text === "string") {
      waiter.answers.push(event.text);
    }
    if (event.type !== "task.completed") return;
    clearTimeout(waiter.timer);
    this.#taskWaiters.delete(key!);
    this.#taskAliases.delete(event.taskId);
    if (event.status === "completed") waiter.resolve(waiter.answers.join("\n"));
    else waiter.reject(new Error(`附件冒烟任务以 ${String(event.status)} 结束。`));
  }
}

function webSocketUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.href;
}

function makeUiFixturePng(): Buffer {
  const width = 480;
  const height = 280;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  fill(pixels, width, height, 0, 0, width, height, [238, 242, 247]);
  fill(pixels, width, height, 0, 0, width, 56, [35, 91, 210]);
  fill(pixels, width, height, 0, 56, 120, height, [71, 78, 92]);
  fill(pixels, width, height, 146, 82, 454, 246, [255, 255, 255]);
  fill(pixels, width, height, 330, 190, 438, 228, [16, 185, 129]);
  drawText(pixels, width, height, 174, 116, "CODEX-7319", 4, [20, 24, 32]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function fill(
  pixels: Buffer,
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  color: [number, number, number],
): void {
  for (let y = Math.max(0, top); y < Math.min(height, bottom); y += 1) {
    for (let x = Math.max(0, left); x < Math.min(width, right); x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      pixels.set(color, offset);
    }
  }
}

const FONT: Record<string, string[]> = {
  C: ["1111", "1000", "1000", "1000", "1000", "1000", "1111"],
  O: ["1111", "1001", "1001", "1001", "1001", "1001", "1111"],
  D: ["1110", "1001", "1001", "1001", "1001", "1001", "1110"],
  E: ["1111", "1000", "1000", "1110", "1000", "1000", "1111"],
  X: ["1001", "1001", "0110", "0110", "0110", "1001", "1001"],
  "-": ["0000", "0000", "0000", "1111", "0000", "0000", "0000"],
  "7": ["1111", "0001", "0010", "0010", "0100", "0100", "0100"],
  "3": ["1110", "0001", "0001", "0110", "0001", "0001", "1110"],
  "1": ["0010", "0110", "0010", "0010", "0010", "0010", "0111"],
  "9": ["1111", "1001", "1001", "1111", "0001", "0001", "1111"],
};

function drawText(
  pixels: Buffer,
  width: number,
  height: number,
  left: number,
  top: number,
  text: string,
  scale: number,
  color: [number, number, number],
): void {
  let cursor = left;
  for (const character of text) {
    const glyph = FONT[character];
    if (!glyph) throw new Error(`图片字体缺少字符 ${character}。`);
    for (let row = 0; row < glyph.length; row += 1) {
      for (let column = 0; column < glyph[row]!.length; column += 1) {
        if (glyph[row]![column] === "1") {
          fill(
            pixels,
            width,
            height,
            cursor + column * scale,
            top + row * scale,
            cursor + (column + 1) * scale,
            top + (row + 1) * scale,
            color,
          );
        }
      }
    }
    cursor += 5 * scale;
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.byteLength + 12);
  result.writeUInt32BE(data.byteLength, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.byteLength - 4);
  return result;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

await main();
