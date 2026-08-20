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
- 手机和电脑同步当前会话的新消息；
- 每个项目同时只允许一个设备控制任务；
- 支持停止任务、断线中断和 WebSocket 心跳；
- 长会话分页加载，完成消息渲染安全的 Markdown 子集；
- 提供模型、权限、计划、检查、回退和用量等斜杠命令；
- 可安装为 PWA，并缓存应用外壳。

当前未实现：Diff 展示、多人账户、任意路径访问、把 App Server 直接暴露到网络、
Codex/Claude Code 在同一项目中并行执行。

## 数据路径

```text
手机或电脑浏览器
  -> HTTPS 入口（Tailscale Serve 或公网反向代理）
  -> 127.0.0.1:8787 上的 Codex Remote
  -> stdio / JSONL
  -> codex app-server
```

应用始终只监听 `127.0.0.1`。Tailscale 和公网 HTTPS 是两种部署入口，不是两套代码。

## 要求

- Linux 主机；
- Node.js 24 或更新版本；
- npm；
- 已安装并登录 Codex CLI；
- `codex app-server --stdio` 可用。

初始开源版本针对 Codex CLI `0.147.0` 开发和测试。App Server 中部分会话设置接口
仍属于实验能力；升级 Codex CLI 后应重新运行测试并做浏览器验收。

Codex App Server 官方说明：https://developers.openai.com/codex/app-server

## 快速启动

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

启动服务：

```bash
CODEX_REMOTE_TOKEN="粘贴刚生成的令牌" \
CODEX_REMOTE_PROJECTS_CONFIG="$PWD/config/projects.json" \
npm start
```

本机健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

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
Codex 运行在专用的非 root 系统账户下。

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `CODEX_REMOTE_TOKEN` | 浏览器 WebSocket 登录令牌，至少 32 个字符 |
| `CODEX_REMOTE_PORT` | 回环监听端口，默认 `8787` |
| `CODEX_REMOTE_ALLOWED_ORIGINS` | 额外允许的浏览器 Origin，逗号分隔；通常留空 |
| `CODEX_REMOTE_PROJECTS_CONFIG` | 项目根目录配置文件，默认 `config/projects.json` |
| `CODEX_REMOTE_STATE_FILE` | 回收站登记文件路径 |
| `CODEX_BIN` | Codex 可执行文件；默认从 `PATH` 查找 |

真实令牌和 `config/projects.json` 都已被 Git 忽略。仓库只保存示例文件。

## 数据与浏览器存储

Codex Remote 不复制对话正文。Codex 负责保存会话；本项目只在状态文件中记录回收站
会话 ID、删除时间和恢复目标，默认保留 30 天。

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

## 许可证

[MIT](LICENSE)。Copyright (c) 2026 lizzyhague。
