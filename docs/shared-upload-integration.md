# 共享上传服务实现与接入说明

本文面向以后接入 Grok Remote、Claude Remote 或维护 Codex Remote 的 AI。共享上传
服务和 Codex 适配已经在本仓库实现；Grok、Claude 项目只应复用本机服务和协议，
不要复制存储、票据、清理或租约代码。

## 已实现范围

- 共享服务入口：`src/shared-upload/main.ts`；
- Unix socket HTTP 服务：`src/shared-upload/server.ts`；
- SQLite、文件落盘和清理：`src/shared-upload/store.ts`；
- Remote 使用的本机客户端：`src/shared-upload/client.ts`；
- Codex 浏览器/后端接入：`src/server/`、`src/workers/` 和 `public/`；
- Codex App Server 输入映射：`src/app-server/turn-session.ts`。

共享服务不启动 AI，不连接浏览器，不读取项目白名单，也不持有会话 Worker。调用方
必须先用自己的登录、Origin、项目和会话规则完成校验，再向共享服务声明绑定信息。

## 进程和数据路径

```text
浏览器
  │ 已认证 WebSocket 申请票据
  │ 同源 POST /attachments/upload 发送原始字节
  ▼
当前 Remote 后端
  │ Unix socket HTTP；流式转交，不整体缓冲
  ▼
ai-remote-upload
  ├── metadata.sqlite
  ├── parts/<随机 ID>.part
  └── blobs/<分片>/<附件 ID>.<安全扩展名>
```

默认路径：

- 存储根目录：`~/.local/share/ai-remote/uploads/`；
- Unix socket：`~/.local/share/ai-remote/upload.sock`；
- SQLite：`~/.local/share/ai-remote/uploads/metadata.sqlite`。

目录权限是 `0700`，数据库和附件是 `0600`，socket 是 `0600`。因此第一版明确要求
共享服务、各 Remote 和对应 coding agent 进程使用同一个 Unix 账户。若另一个项目
使用不同系统账户，不能简单放宽 socket 权限；还必须重新设计附件文件读取权限和
调用方身份认证。

## 固定规则和时限

- 单文件最多 25 MiB；服务端同时核对票据大小、HTTP `Content-Length` 和实际字节数；
- 完成附件保留 30 天；
- 上传票据有效 10 分钟，只能使用一次，SQLite 只保存票据 SHA-256；
- `.part` 文件一小时后可清理；
- 任务租约有效 15 分钟，Remote 每 5 分钟续期；
- 服务启动时补做清理，运行期间每小时清理；
- 默认至少保留 1 GiB 可用磁盘，`AI_REMOTE_UPLOAD_MIN_FREE_MIB` 可以覆盖；
- 一条消息最多引用 100 个附件；不设置长期总数或每日配额。

以上是共享层限制。Codex 适配另有一条上下文限制：同一消息的 UTF-8 文本附件合计
最多 512 KiB；这不影响文件上传和其它 Remote 以后采用自己的适配限制。

上传时使用 `wx` 创建临时文件，边写边计算 SHA-256，完整接收并 `fsync` 后原子重命名。
PNG、JPEG、GIF 和 WebP 通过文件签名识别为图片；PDF 也通过签名识别。其余内容按
普通文件处理，客户端声明的 MIME 和扩展名不能单独把文件升级为图片。定时清理也会
删除“文件已重命名、元数据尚未提交”这一崩溃窗口留下的一小时以上孤立 blob。

## 本机 API

以下 API 只在 Unix socket 上提供。JSON 错误统一为：

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "可读说明"
  }
}
```

### 创建票据

`POST /v1/tickets`

```json
{
  "caller": "grok",
  "projectId": "projects/example",
  "sessionId": "session-id",
  "originalName": "screen.png",
  "declaredMime": "image/png",
  "expectedSize": 12345
}
```

`caller` 只能是 `codex`、`grok` 或 `claude`。返回票据、过期时间和不含路径的公开
元数据。票据是 bearer secret，不应写入 URL、日志或持久化浏览器存储。

### 上传字节

`POST /v1/uploads`

请求头必须带 `X-Upload-Ticket` 和 `Content-Length`，正文是原始文件字节。返回：

```json
{
  "attachment": {
    "id": "UUID",
    "caller": "grok",
    "projectId": "projects/example",
    "sessionId": "session-id",
    "originalName": "screen.png",
    "declaredMime": "image/png",
    "detectedMime": "image/png",
    "kind": "image",
    "size": 12345,
    "sha256": "...",
    "createdAtMs": 0,
    "expiresAtMs": 0
  }
}
```

这个响应可以转给浏览器，其中没有主机路径。

### 创建和维护任务租约

`POST /v1/leases` 接收 `caller`、`projectId`、`sessionId`、`ownerId` 和
`attachmentIds`。服务再次核对所有附件的绑定和过期时间，返回租约以及带绝对路径的
`attachments`。

租约响应是本机后端专用数据，绝对路径不能进入浏览器协议、对外 HTTP 响应或公开
日志。Remote 固化公开元数据和附件 ID，路径只在启动 AI 任务时短暂使用。

- `POST /v1/leases/<leaseId>/renew`，正文 `{ "ownerId": "..." }`；
- `POST /v1/leases/<leaseId>/release`，正文 `{ "ownerId": "..." }`。

任务排队、运行和等待审批期间都要保留租约；完成、失败或中断后释放。Remote 崩溃时
未释放的租约会自然过期，避免附件永久无法清理。

## Remote 接入顺序

Grok 或 Claude 项目的 AI 应按下面顺序实施：

1. 先核对该 Remote 的真实项目 ID、会话 ID、鉴权和消息幂等机制；不要照抄 Codex
   的 `SessionWorkerManager`。
2. 配置与共享服务相同的 `AI_REMOTE_UPLOAD_SOCKET`，优先复用
   `SharedUploadClient`；若项目不能导入本仓库代码，就按上面的 Unix socket HTTP
   契约实现一个很薄的客户端。
3. 在已经认证的 WebSocket 上增加票据请求。调用方由后端固定为 `grok` 或 `claude`，
   不能相信浏览器传来的 caller、项目、会话或服务器路径。
4. 增加当前 Remote 自己的同源 `POST /attachments/upload`。只转交票据和字节流，
   不先把文件读进内存，也不要为共享服务新增公网或 Tailscale 入口。
5. 前端保存并发送附件 ID；发送消息前不得自动提交。断线幂等记录必须同时包含正文和
   附件 ID。
6. 后端接受任务时创建租约并持久化公开附件元数据；启动任务时才使用租约返回的路径。
7. 按该 coding agent 当时的真实协议实现适配，并做内容级验收；看到文件存在不等于
   模型理解了内容。

## Codex 适配的现状

Codex 图片映射为 App Server `localImage`：

```json
{ "type": "localImage", "path": "/仅后端可见的路径/screen.png" }
```

Codex CLI 0.147.0 的公开输入协议没有通用本地文件块。`mention` 的 `path` 指向
`app://` 或 `plugin://` 等引用目标，不是本地文件读取接口。因此普通 UTF-8 文本由
Codex Remote 后端读取，并作为带私有标记的第二个 `text` 输入发送：

```json
{
  "type": "text",
  "text": "[CODEX_REMOTE_PRIVATE_ATTACHMENT_CONTENT_V1]\n附件名：notes.txt\n...",
  "text_elements": []
}
```

私有文本块不含服务器路径，并在实时事件和重新加载历史时被过滤；浏览器仍只看到
“原始文件名 + 附件 ID”。文本附件合计超过 512 KiB、不是有效 UTF-8，或属于 PDF
等当前无法消费的二进制格式时，会在任务入队前给出明确错误。不要把这些格式伪装成
`mention` 后声称已经读取。

官方 App Server 文档明确列出 `localImage`。官方 Codex 源码也把 `mention` 定义为
应用/插件等结构化引用，而不是通用本地文件。因此升级 Codex CLI 后必须重新生成类型，
并分别实测图片和普通文件。

官方 App Server 文档：https://developers.openai.com/codex/app-server/

官方 `UserInput` 源码：https://github.com/openai/codex/blob/main/codex-rs/protocol/src/user_input.rs

## Grok 和 Claude 的适配边界

本仓库没有实现以下两项：

- Grok：按届时的 CLI/ACP 行为验证本地路径引用是否真的产生视觉理解；如果只能看到
  文件名或无法读取图片，再讨论 OCR/视觉降级，不要静默声称成功。
- Claude：根据届时采用的 CLI 或 API 映射为原生图片/文件输入；不能假设其输入结构
  与 Codex 相同。

无论适配方式如何，浏览器只应看到公开元数据和附件 ID。coding agent 不支持某种
格式时，应明确告诉用户，而不是把成功落盘等同于成功理解。

## 最低验收清单

- 同名、重复、多文件、零字节、25 MiB 边界和超限文件；
- 票据过期、重复使用、上传中断和声明/实际大小不一致；
- caller、项目或会话不匹配时拒绝创建租约；
- 浏览器响应、WebSocket、错误和日志不包含存储绝对路径；
- 任务排队超过清理时点时租约阻止删除，任务结束后可以清理；
- 服务重启清理旧 `.part`、过期票据和过期租约；
- 真实截图的文字、颜色、控件位置和布局理解；
- 至少一种普通文本文件，以及目标 agent 声称支持的其它格式。

Codex Remote 仓库提供 `npm run smoke:attachments`：它默认连接
`http://127.0.0.1:18787`，生成一张带文字和右下角绿色控件的 PNG 及一个文本文件，
通过真实上传、租约和 App Server turn 验证内容级理解。可用
`CODEX_REMOTE_SMOKE_URL`、`CODEX_REMOTE_SMOKE_TOKEN` 和
`CODEX_REMOTE_SMOKE_PROJECT` 覆盖目标；这个检查会创建一个真实 Codex 会话并产生一次
模型调用，只应在明确的测试环境运行。
