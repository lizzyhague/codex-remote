# Codex Remote

Codex Remote 是一个面向单用户、自托管场景的 PWA，用手机或电脑控制远程 Linux 或 macOS
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
  后端把附件真实路径交给 Codex，由它按用户请求调用可用工具读取；页面不显示存储路径；
- 每个活动会话使用独立 App Server Worker；同一项目仍只运行一个任务；
- Worker 完成队列后立即退出并释放该会话的 writer，不依赖浏览器连接生命周期；
- 普通权限离线等待 10 秒后会取消需要审批的整轮，Full access 可继续处理执行审批；
- 长会话分页加载，完成消息渲染安全的 Markdown 子集；
- 在登录后查看项目根目录内的 Markdown 和图片，不提供源码查看、下载或目录浏览；
- 提供压缩、重命名、回退等斜杠命令；模型和权限由输入框旁的下拉承担，用量在顶部常驻信息条；
- 可安装为 PWA；联网时普通刷新即可加载新版外壳。

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

- Linux 或 macOS 主机；
- Node.js 24 或更新版本；
- npm；
- 已安装并登录 Codex CLI；
- `codex app-server --stdio` 可用；
- 使用附件时，需要与本服务同一 Unix 账号运行的独立 [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload) 服务。

常驻服务应以已经安装并登录 Codex、且能访问允许项目的非 root Unix 用户运行。部署者
可以使用现有用户，也可以为服务准备独立用户；仓库不假定固定账户、HOME 或安装路径。

项目最近完整验证过的 Codex CLI 版本、类型输出目录和 experimental surface 选择只记录在
[`codex-protocol.json`](codex-protocol.json)。这是项目维护信息，不限制用户安装或运行其他版本的
Codex CLI。App Server 中部分会话设置接口仍属于实验能力；维护者确认新版本时按下文入口
重新生成和验收，再更新这个已验证版本号。

Codex App Server 官方说明：https://developers.openai.com/codex/app-server

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
普通文件夹会成为网页中的可选项目。每个 root ID 和经 `realpath` 解析后的根目录都必须
唯一；不同 root 下若有同名项目，网页会用公开的 root ID 消歧，不会显示主机路径：

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

使用附件时，先按 [`ai-remote-upload`](https://github.com/lizzyhague/ai-remote-upload) 的说明启动独立上传服务，再启动 Codex Remote：

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

然后选择一种 HTTPS 入口，说明都在 [`docs/deployment.md`](docs/deployment.md)：

- Tailscale Serve（第 4a 节）：访问设备需要加入 tailnet，默认推荐；
- 公网 HTTPS（第 4b 节）：普通浏览器可直接访问，但需要承担额外的公网攻击面。

Linux / macOS 常驻运行、更新和日志见 [运维说明](docs/operations.md)；多主机见
`docs/deployment.md` 第 5 节。

## 权限默认值

Codex Remote 不覆盖 Codex 的默认权限配置。新建或恢复会话时，权限由部署主机上的
Codex 配置决定；登录后可以通过输入框旁的权限下拉，查看和切换 App Server 返回的可用
权限 profile。

当前会话是不是 full access，以 App Server 返回的沙箱策略为准，不按权限 profile 的
名字推断。关闭 full access 会切到一个可用的受限 profile；如果主机上一个受限 profile
都没有，Remote 会直接报错，而不是谎称已经关闭。

选择 full access 会扩大令牌泄露后的影响范围。公网部署尤其应保留受限权限，并让
Codex 运行在权限边界明确的非 root Unix 用户下。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `CODEX_REMOTE_TOKEN` | 浏览器登录凭据，至少 32 个字符 |
| `CODEX_REMOTE_PORT` | 回环监听端口；未设置时默认 `3000`，正式部署建议显式设置 |
| `CODEX_REMOTE_ALLOWED_ORIGINS` | 额外允许的浏览器 Origin，逗号分隔；通常留空 |
| `CODEX_REMOTE_PROJECTS_CONFIG` | 项目根目录配置文件，默认 `config/projects.json` |
| `CODEX_REMOTE_STATE_FILE` | 回收站登记文件路径 |
| `CODEX_REMOTE_MARKS_FILE` | 钉住会话记录路径；未设置时为回收站文件同目录下的 `marks.json` |
| `CODEX_REMOTE_SETTINGS_FILE` | 应用设置 JSON 路径；未设置时为状态目录下的 `settings.json` |
| `CODEX_REMOTE_WORK_STATE_FILE` | 已接受任务与事件日志的 SQLite 路径 |
| `AI_REMOTE_UPLOAD_SOCKET` | 共享上传服务 Unix socket；默认 `~/.local/share/ai-remote/upload.sock` |
| `CODEX_REMOTE_MAX_WORKERS` | 最大活动 Worker 数，默认 `2` |
| `CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB` | 启动 Worker 所需保守可用内存预算，默认 `1024` MiB；Linux 与 macOS 读数语义一致，可共用同一个值，设为 `0` 会关闭启动前保护 |
| `CODEX_REMOTE_OFFLINE_GRACE_MS` | 最后一个客户端离线后的审批宽限期，默认 `10000` 毫秒；取值为 `0` 到 `2147483647`（约 24.8 天）的整数，超出范围时服务拒绝启动 |
| `CODEX_BIN` | Codex 可执行文件；默认从 `PATH` 查找 |

真实令牌和 `config/projects.json` 都已被 Git 忽略。仓库只保存示例文件。

附件本体由独立的 `ai-remote-upload` 服务保存。安装见该项目的部署说明；本仓库只配置
`AI_REMOTE_UPLOAD_SOCKET`。

## 数据与浏览器存储

Codex 仍负责保存原生会话和完整历史。为了支持后台执行，Codex Remote 还会在 Worker
状态库中保存已接受消息、任务状态、脱敏后的流事件和中断原因；这份日志可能包含对话
正文、附件公开元数据和工具输出，应按与 Codex 会话数据相同的敏感级别保护。附件
字节由独立上传服务保存，默认仍保留 30 天。回收站登记仍单独保存，默认保留 30 天。
钉住记录默认保存在回收站文件同目录的 `marks.json`。应用设置（当前是附加 Developer
指令）保存在同一私有状态目录的 `settings.json`，由后端写入，不进仓库。空字符串表示
不追加用户内容。Worker 状态库同目录下的 `attachment-index/` 保存附件原名与本机真实路径，
用于恢复页面显示；它不含附件字节，但仍是需要保护和备份的敏感状态数据。

浏览器登录时把访问令牌交给 HTTP 登录端点，随后只保存服务签发的 `HttpOnly` 签名
cookie，令牌本身不写入浏览器存储。cookie 不依赖内存会话表，服务重启后仍然有效；
更换服务端令牌会立即让所有旧 cookie 失效。

更完整的信任边界见 [架构说明](docs/architecture.md) 和 [安全策略](SECURITY.md)。

## 开发与检查

```bash
npm run typecheck
npm test
npm run codex:types
npm run codex:protocol
```

`npm run codex:types` 用当前安装的 Codex CLI，在隔离的 `CODEX_HOME` 中按 manifest 记录的
experimental 选择重新生成并逐字节比较真正被业务 import 的
`src/generated/`。当前生成结果不包含生成器的完整 experimental surface；这与运行时为已采用方法
设置 `experimentalApi: true` 是两个独立边界。`npm run codex:protocol` 会连接当前安装版本的真实 App Server，只做
experimental 初始化和只读协议查询，不创建 thread，也不调用模型。这两项和
`npm run typecheck && npm test` 一起构成无需模型的协议升级检查。

会创建真实会话并调用模型的端到端检查（当前是 `npm run smoke:attachments`）不属于单元测试，
只应在测试实例、附件服务、项目配置和 Codex 登录状态都准备好，并且明确允许模型调用时运行。
`npm run smoke:server` 会启动临时网页后端并读取真实项目/会话目录，同样不在普通单测中运行。

`src/generated/` 是生成器的完整输出，不手工裁剪或编辑。升级步骤、`--write` 用法和差异审查清单
见[运维说明](docs/operations.md#codex-cli-与-app-server-协议升级)。类型检查和 fake transport
单测不能替代真实 App Server 协议检查。

## 许可证与商标

代码按 [Apache License 2.0](LICENSE) 发布。Copyright (c) 2026 lizzyhague。

项目名称 “Codex Remote”、logo 及其他品牌素材**不在** Apache License 2.0 的授权范围
内，版权人保留全部权利（见许可证第 6 条：本许可证不授予商标权）。你可以自由使用、
修改和再分发本项目代码，但请为衍生版本使用你自己的名称和标识。

本项目不是 OpenAI 官方产品，与 OpenAI 无任何关联，也未获其背书或赞助。“OpenAI”、
“Codex” 等商标归各自所有者所有，此处仅用于说明本软件所对接的对象。

其余声明见 [NOTICE](NOTICE)。
