# Codex Remote

Codex Remote 是一个面向单用户、自托管场景的 PWA，用手机或电脑控制远程 Linux
主机上的 Codex CLI。消息在浏览器本地编辑，完整发送后才经过网络，因此不会受到
SSH 逐键输入延迟的影响。

后端是一个薄适配层：浏览器连接 Codex Remote 自己的受限 WebSocket 协议，Node.js
服务再通过 stdio/JSONL 驱动 `codex app-server`。浏览器不能直接连接 App Server，
也不能提交任意工作目录。

> 本项目不是 OpenAI 官方产品，也不是多人账户系统。它假设部署者是唯一受信任的
> 使用者。不要把一个实例作为公开注册服务提供给陌生人。

## 功能

- 从配置的项目根目录中选择项目；
- 搜索、新建、恢复、归档和删除 Codex 会话；
- 流式显示回复、命令状态和审批请求；
- 手机和电脑同步当前会话的新消息、审批和用户输入请求；
- 消息由后端持久化确认，页面关闭后仍可继续执行，并用 `clientMessageId` 避免断线重发；
- 可在手机或电脑选择多个截图或普通文件，先上传到本机共享服务，再随消息确认发送；
  当前 Codex 原生理解图片和合计不超过 512 KiB 的 UTF-8 文本，其它格式会明确报错；
- 每个活动会话使用独立 App Server Worker；同一项目仍只运行一个任务；
- Worker 完成队列后立即退出并释放该会话的 writer，不依赖浏览器连接生命周期；
- 普通权限离线等待 10 秒后会取消需要审批的整轮，Full access 可继续处理执行审批；
- 长会话分页加载，完成消息渲染安全的 Markdown 子集；
- 提供模型、权限、计划、检查、回退和用量等斜杠命令，以及输入框下的常用快捷入口；
- 可安装为 PWA，并缓存应用外壳。

当前未实现：Diff 展示、多人账户、任意路径访问、把 App Server 直接暴露到网络、
Codex/Claude Code 在同一项目中并行执行。

## 数据路径

```text
手机或电脑浏览器
  -> HTTPS 入口（Tailscale Serve 或公网反向代理）
  -> 127.0.0.1:<CODEX_REMOTE_PORT> 上的 Codex Remote
  -> Unix socket 上的共享上传服务（附件路径）
  -> 后端队列与 SQLite 事件日志
  -> 每个活动会话独立的 stdio / JSONL codex app-server Worker
```

应用始终只监听 `127.0.0.1`。Tailscale 和公网 HTTPS 是两种部署入口，不是两套代码。

## 要求

- Linux 主机；
- Node.js 24 或更新版本；
- npm；
- 已安装并登录 Codex CLI；
- `codex app-server --stdio` 可用。

常驻服务应以已经安装并登录 Codex、且能访问允许项目的非 root Unix 用户运行。部署者
可以使用现有用户，也可以为服务准备独立用户；仓库不假定固定账户、HOME 或安装路径。

初始开源版本针对 Codex CLI `0.147.0` 开发和测试。App Server 中部分会话设置接口
仍属于实验能力；升级 Codex CLI 后应重新运行测试并做浏览器验收。

Codex App Server 官方说明：https://developers.openai.com/codex/app-server

## 让 AI 帮你部署

如果不熟悉 Linux、systemd 或反向代理，可以把仓库地址交给 AI，并要求它先完整阅读
[AI 部署与交接规范](docs/deployment-ai.md)。这份规范会引导 AI：

- 先只读核对主机环境，不根据示例路径猜测真实配置；
- 让用户选择 Tailscale 私网或公网 HTTPS，不擅自替换部署路径；
- 在改文件、安装软件或使用管理员权限前，说明影响并取得确认；
- 分阶段验证服务、HTTPS 入口和浏览器行为；
- 部署完成后，主动讲清安全边界、多终端行为和日常维护注意事项。

可以把下面这段话连同仓库地址发给部署 AI：

> 请先完整阅读 `docs/deployment-ai.md`，再帮助我部署。第一步只做环境检查和方案说明，
> 不要安装软件、修改文件或使用管理员权限。把需要我决定的事项、准备执行的操作和
> 会改动的文件列清楚，等我确认后再分阶段执行。完成后请按文档中的交接模板向我说明
> 安全边界、多终端连接行为、令牌保管和维护方法。

## 快速启动

以下命令用于本机试运行，不等同于已经完成远程 HTTPS 和常驻服务部署。

安装依赖：

```bash
npm ci
```

创建项目白名单：

```bash
cp config/projects.example.json config/projects.json
```

编辑 `config/projects.json`，把 `path` 改为真实的绝对路径。每个根目录下面第一层的
普通文件夹会成为网页中的可选项目：

```json
{
  "roots": [
    {
      "id": "projects",
      "path": "/srv/projects"
    }
  ]
}
```

生成一个访问令牌：

```bash
openssl rand -hex 32
```

先在一个终端启动共享上传服务：

```bash
npm run start:uploads
```

再在另一个终端启动 Codex Remote：

```bash
CODEX_REMOTE_TOKEN="粘贴刚生成的令牌" \
CODEX_REMOTE_PROJECTS_CONFIG="$PWD/config/projects.json" \
npm start
```

本机健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

`3000` 是本地开发默认值。正式部署应显式设置回环端口；HTTPS 入口端口由
Tailscale Serve 或其它反向代理单独选择，两者不要求使用相同数字。

然后选择一种 HTTPS 入口：

- [Tailscale Serve 私网部署](docs/deployment-tailscale.md)：访问设备需要加入 tailnet，
  默认推荐；
- [公网 HTTPS 部署](docs/deployment-public.md)：普通浏览器可直接访问，但需要承担额外
  的公网攻击面。

常驻运行、更新和日志说明见 [运维说明](docs/operations.md)。

## 权限默认值

Codex Remote 不覆盖 Codex 的默认权限配置。新建或恢复会话时，权限由部署主机上的
Codex 配置决定；登录后可以通过 `/permissions` 查看和切换 App Server 返回的可用
权限 profile。

选择 full access 会扩大令牌泄露后的影响范围。公网部署尤其应保留受限权限，并让
Codex 运行在权限边界明确的非 root Unix 用户下。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `CODEX_REMOTE_TOKEN` | 浏览器 WebSocket 登录令牌，至少 32 个字符 |
| `CODEX_REMOTE_PORT` | 回环监听端口；未设置时默认 `3000`，正式部署建议显式设置 |
| `CODEX_REMOTE_ALLOWED_ORIGINS` | 额外允许的浏览器 Origin，逗号分隔；通常留空 |
| `CODEX_REMOTE_PROJECTS_CONFIG` | 项目根目录配置文件，默认 `config/projects.json` |
| `CODEX_REMOTE_STATE_FILE` | 回收站登记文件路径 |
| `CODEX_REMOTE_WORK_STATE_FILE` | 已接受任务与事件日志的 SQLite 路径 |
| `AI_REMOTE_UPLOAD_SOCKET` | 共享上传服务 Unix socket；默认 `~/.local/share/ai-remote/upload.sock` |
| `CODEX_REMOTE_MAX_WORKERS` | 最大活动 Worker 数，默认 `2` |
| `CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB` | 启动 Worker 所需最低可用内存，默认 `1024` MiB |
| `CODEX_REMOTE_OFFLINE_GRACE_MS` | 最后一个客户端离线后的审批宽限期，默认 `10000` 毫秒 |
| `CODEX_BIN` | Codex 可执行文件；默认从 `PATH` 查找 |

真实令牌和 `config/projects.json` 都已被 Git 忽略。仓库只保存示例文件。

共享上传服务另有 `AI_REMOTE_UPLOAD_ROOT` 和 `AI_REMOTE_UPLOAD_MIN_FREE_MIB`。完整接口、
数据目录和其它 Remote 的接入方式见
[共享上传服务实现与接入说明](docs/shared-upload-integration.md)。

## 数据与浏览器存储

Codex 仍负责保存原生会话和完整历史。为了支持后台执行，Codex Remote 还会在 Worker
状态库中保存已接受消息、任务状态、脱敏后的流事件和中断原因；这份日志可能包含对话
正文、附件公开元数据和工具输出，应按与 Codex 会话数据相同的敏感级别保护。附件
字节和元数据 SQLite 默认位于 `~/.local/share/ai-remote/uploads/`，同样属于敏感
数据并保留 30 天。回收站登记仍单独保存，默认保留 30 天。

访问令牌会保存在浏览器 `localStorage`，用于刷新和断线重连。不要在共享设备上保存
令牌；怀疑泄露时应立即更换服务端令牌，并清除已登录浏览器中的旧值。

更完整的信任边界见 [架构说明](docs/architecture.md) 和 [安全策略](SECURITY.md)。

## 开发与检查

```bash
npm run typecheck
npm test
```

`npm run smoke` 会连接真实的 Codex App Server；`npm run smoke:server` 会启动真实网页
后端，因此只在本机环境变量、项目配置和 Codex 登录状态都准备好时运行。

`src/generated/` 中的 TypeScript 类型由 Codex CLI 生成，并与生成时使用的 Codex
版本绑定。官方生成命令为：

```bash
codex app-server generate-ts --out ./schemas
```

升级类型时应记录 Codex CLI 版本、检查生成差异，并运行全部测试。

## 许可证与商标

代码按 [Apache License 2.0](LICENSE) 发布。Copyright (c) 2026 lizzyhague。

项目名称 “Codex Remote”、logo 及其他品牌素材**不在** Apache License 2.0 的授权范围
内，版权人保留全部权利（见许可证第 6 条：本许可证不授予商标权）。你可以自由使用、
修改和再分发本项目代码，但请为衍生版本使用你自己的名称和标识。

本项目不是 OpenAI 官方产品，与 OpenAI 无任何关联，也未获其背书或赞助。“OpenAI”、
“Codex” 等商标归各自所有者所有，此处仅用于说明本软件所对接的对象。

其余声明见 [NOTICE](NOTICE)。
