# 部署说明

后端只监听 `127.0.0.1`，HTTPS 入口是独立的一层，两个端口不要求相同。先把本地后端跑
通，再配入口。

真实令牌和主机路径不提交。`config/projects.json`、`deploy/*.env`、`deploy/*.local`
都已被 `.gitignore` 排除。

## 1. 准备

服务由**已经安装并登录 Codex 的非 root Unix 用户**运行：Codex 从该用户的 HOME 读登录
状态和会话，附件也要访问同一用户下的 socket。用专用服务账号也可以，但要在该账号下
单独装 Codex、登录、给项目权限——不要靠放宽数据目录权限跨账号共享。

在该用户的登录环境中核验（要求 Node.js 24 以上）：

```bash
id -un; id -gn; printf '%s\n' "$HOME"
node --version
command -v node; command -v codex
```

运行用户的 HOME 保存 Codex 的登录和会话，所以不能给单元加 `ProtectHome=true` 这类
会挡住这些目录的限制。

## 2. 装代码和配置

```bash
git clone https://github.com/lizzyhague/codex-remote.git
cd codex-remote
npm ci --include=dev
npm run typecheck && npm test

cp config/projects.example.json config/projects.json
cp deploy/codex-remote.env.example deploy/codex-remote.env
cp deploy/ai-remote-upload.env.example deploy/ai-remote-upload.env
chmod 600 config/projects.json deploy/*.env
openssl rand -hex 32
```

编辑 `config/projects.json`，把示例根目录换成本机实际目录；网页里可选的项目，是每个
根目录下的第一层文件夹。不要把 `/` 或整个 HOME 配成项目根目录。

编辑 `deploy/codex-remote.env`，至少填：

| 变量 | 填什么 |
| --- | --- |
| `CODEX_REMOTE_TOKEN` | 上面 `openssl` 生成的随机值，至少 32 字符 |
| `CODEX_REMOTE_PORT` | 未占用的回环端口（不设置时默认 3000） |
| `CODEX_REMOTE_PROJECTS_CONFIG` | `config/projects.json` 的绝对路径 |
| `CODEX_BIN` | `command -v codex` 返回的绝对路径 |

`CODEX_REMOTE_ALLOWED_ORIGINS` 通常留空；只有反向代理不保留 `Host` /
`X-Forwarded-Host` 时才填完整 Origin。

## 3a. Linux + systemd

```bash
cp deploy/codex-remote.service.example deploy/codex-remote.service.local
cp deploy/ai-remote-upload.service.example deploy/ai-remote-upload.service.local
```

替换两个本地副本里的占位符：`__RUN_USER__`、`__RUN_GROUP__`、`__RUN_HOME__`、
`__APP_DIR__`（仓库根目录）、`__ENV_FILE__`、`__UPLOAD_ENV_FILE__`、`__NODE_BIN__`、
`__RUNTIME_PATH__`（含 Node 和 Codex 的完整 PATH）。

```bash
grep -n '__[A-Z_]*__' deploy/*.service.local   # 应无输出
sudo install -m 0644 deploy/ai-remote-upload.service.local /etc/systemd/system/ai-remote-upload.service
sudo install -m 0644 deploy/codex-remote.service.local /etc/systemd/system/codex-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-remote-upload.service
sudo systemctl enable --now codex-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

已有主机若不想覆盖自己的 `codex-remote.service`，可以只装
`deploy/codex-remote-upload.conf` 为
`/etc/systemd/system/codex-remote.service.d/20-ai-remote-upload.conf` 再
`daemon-reload`。它用 `Wants` 而不是 `Requires`：共享服务坏了只让附件失败，不挡纯文本
启动。

## 3b. macOS + launchd

用系统级 LaunchDaemon，服务不依赖图形登录；`UserName` 仍是上面那个已登录 Codex 的
普通用户。两个服务各一份 plist。

```bash
cp deploy/launchd/ai-remote-upload.plist.example deploy/launchd/ai-remote-upload.plist.local
cp deploy/launchd/codex-remote.plist.example deploy/launchd/codex-remote.plist.local
mkdir -p "$HOME/Library/Logs/codex-remote" && chmod 700 "$HOME/Library/Logs/codex-remote"
```

占位符比 systemd 多两个：`__SERVICE_LABEL__`（每个实例用不同的 launchd label）和
`__LOG_DIR__`。文件名、plist 里的 `Label` 和 `launchctl` 命令三者必须一致；下面的
`io.example.*` 只是例子。

```bash
grep -n '__[A-Z_]*__' deploy/launchd/*.plist.local   # 应无输出
plutil -lint deploy/launchd/*.plist.local
sudo install -o root -g wheel -m 0644 deploy/launchd/ai-remote-upload.plist.local \
  /Library/LaunchDaemons/io.example.ai-remote-upload.plist
sudo install -o root -g wheel -m 0644 deploy/launchd/codex-remote.plist.local \
  /Library/LaunchDaemons/io.example.codex-remote.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.example.ai-remote-upload.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.example.codex-remote.plist
curl --fail --show-error http://127.0.0.1:3000/healthz
```

两个服务不建立启动顺序；共享服务没起来时，只有附件会失败。

需要代理时，把 `HTTPS_PROXY` 等写进 `deploy/codex-remote.env`，并用 `NO_PROXY` 保持
`127.0.0.1`、`localhost` 和私网入口直连。

健康检查不过就不要往下配入口。

## 4a. Tailscale Serve（只给 tailnet）

```bash
tailscale serve status                                    # 先看有没有占用
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status
```

端口按本机实际情况选。首次使用可能要在浏览器里启用 tailnet HTTPS。然后从另一台
tailnet 设备打开状态里显示的地址登录，发一条测试消息。

Tailscale 身份管网络访问，应用令牌管登录，两层独立。不要把 `serve` 换成 `funnel` 还
当私网用——那是公网入口。

## 4b. 公网 HTTPS

公网地址会持续被扫描。上这条路径前先明白：令牌泄露等于别人可以驱动你的 Codex；
应用令牌是长期共享凭证，不是用户身份系统。

最低要求：非 root 用户运行、高熵独立令牌、只开放 80/443 而后端保持回环、有效
HTTPS、项目根目录尽量窄、代理层设连接和请求限制。

Caddy 最小配置：

```caddyfile
codex.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl https://codex.example.com/healthz
```

换别的反向代理时必须同时满足：正确转发 WebSocket Upgrade、保留原始 `Host` 或设对
`X-Forwarded-Host`、不允许外部伪造受信任代理头。

上线前在浏览器里确认：HTTP 跳 HTTPS、错误令牌登不进、正确令牌能加载项目列表、
WebSocket 是 `wss://`、公网地址访问不到后端回环端口。

## 5. 多主机

推荐"同一版本、独立实例"：源码可以来自同一个 commit，但令牌、端口、入口、项目白名单、
状态文件、上传目录和 socket 每台各一份，不共享运行中的 Worker 或数据库。不要用文件
同步工具同时写两台机器上的 SQLite、附件目录或 Codex 会话目录。

最省事的迁移是不带历史：新机装同版本、独立登录 Codex、配自己的白名单和入口，验收
通过后再决定停不停旧实例。
