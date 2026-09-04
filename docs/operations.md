# 运维说明

本文说明 Linux 主机上的 systemd 常驻运行、更新和日志。macOS 请参阅
[macOS 常驻部署](deployment-macos.md)，跨主机切换和状态迁移请参阅
[实例迁移与多主机部署](migration.md)。网络入口请分别参阅：

- [Tailscale Serve 私网部署](deployment-tailscale.md)
- [公网 HTTPS 部署](deployment-public.md)

由 AI 协助部署时，AI 还必须遵守 [AI 部署与交接规范](deployment-ai.md)。不能只以
`systemctl is-active` 或 `/healthz` 成功就宣布部署完成；还要验证实际 HTTPS 入口、
浏览器登录和后端监听地址，并向用户完成安全与使用规则交接。

Codex Remote 固定监听 `127.0.0.1`，systemd 单元不依赖具体入口。HTTPS 入口端口和
`CODEX_REMOTE_PORT` 是两项独立配置，仓库不为部署主机分配端口。

## systemd 模板

仓库提交的 `deploy/*.service.example` 和 `deploy/*.env.example` 只包含占位值。部署者
应在被 Git 忽略的本地副本中填写真实配置，不能假设每台主机的用户名、Node.js、
Codex CLI、代码路径或端口相同。

### 选择运行用户

Codex Remote 必须以已经安装并登录 Codex、且能读写允许项目的非 root Unix 用户运行。
通常有两种有效选择：

- 使用已有的 coding-agent 用户：沿用该用户的 Codex 登录和项目权限，配置较直接；
- 使用专用服务用户：隔离更强，但必须在该用户身份下单独安装并登录 Codex，并明确
  授予项目访问权限。

不要只因模板里出现某个名称就创建同名用户。无论选择哪一种，安装前至少核对：

- `User`、`Group` 和 `HOME`；
- `WorkingDirectory` 与 `ExecStart`；
- Node.js 和 `CODEX_BIN` 的绝对路径；
- 项目配置、状态目录及其文件权限；
- 服务账户是否已经登录 Codex，以及是否能读写允许的项目。

Codex CLI 的安装和登录方式以 OpenAI 官方文档为准：

- https://developers.openai.com/codex/cli
- https://developers.openai.com/codex/auth

共享附件服务和 Codex Remote 必须使用同一个 Unix 用户，才能访问权限为 `0600` 的
Unix socket 和附件文件。默认 socket 是 `~/.local/share/ai-remote/upload.sock`。

运行用户的 `HOME` 保存 Codex 自己的登录和会话数据，因此不能把 `ProtectHome=true`
等会阻断这些目录的 systemd 限制直接照搬进来。

### 准备本机配置

```bash
cp config/projects.example.json config/projects.json
cp deploy/codex-remote.env.example deploy/codex-remote.env
cp deploy/ai-remote-upload.env.example deploy/ai-remote-upload.env
cp deploy/codex-remote.service.example deploy/codex-remote.service.local
cp deploy/ai-remote-upload.service.example deploy/ai-remote-upload.service.local
chmod 600 config/projects.json deploy/codex-remote.env deploy/ai-remote-upload.env
```

这些本机文件均应保持未跟踪。编辑项目白名单和环境文件时填写真实绝对路径，并在
`CODEX_REMOTE_PORT` 中显式选择未占用的后端回环端口。程序未设置该变量时默认使用
`3000`，这只是开发默认值。HTTPS 入口端口不写入该环境文件，由所选反向代理单独配置。

两份 `.service.local` 中需要替换的占位符如下：

| 占位符 | 填写内容 |
| --- | --- |
| `__RUN_USER__` | `id -un` 的结果 |
| `__RUN_GROUP__` | `id -gn` 的结果 |
| `__RUN_HOME__` | 运行用户的 HOME 绝对路径 |
| `__APP_DIR__` | 仓库根目录绝对路径 |
| `__ENV_FILE__` | `deploy/codex-remote.env` 的绝对路径 |
| `__UPLOAD_ENV_FILE__` | `deploy/ai-remote-upload.env` 的绝对路径 |
| `__NODE_BIN__` | `command -v node` 的绝对路径 |
| `__RUNTIME_PATH__` | 包含 Node、Codex 和常用系统命令目录的完整 `PATH` |

确认没有遗留占位符：

```bash
if grep -n '__[A-Z_]*__' deploy/*.service.local; then
  echo 'systemd 模板仍有未替换的占位符' >&2
  exit 1
fi
```

### 安装并启动单元

以下系统级操作需要管理员权限：

```bash
sudo install -m 0644 deploy/ai-remote-upload.service.local \
  /etc/systemd/system/ai-remote-upload.service
sudo install -m 0644 deploy/codex-remote.service.local \
  /etc/systemd/system/codex-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-remote-upload.service
sudo systemctl enable --now codex-remote.service
```

不要把带 `__PLACEHOLDER__` 的公开模板直接安装到 `/etc/systemd/system/`。

已有主机如果不覆盖自己的 `codex-remote.service`，可只安装
`deploy/codex-remote-upload.conf` 为
`/etc/systemd/system/codex-remote.service.d/20-ai-remote-upload.conf`，再执行
`systemctl daemon-reload`。这个 drop-in 使用 `Wants` 而不是 `Requires`：共享服务故障
只会让附件操作明确失败，不会阻止纯文本 Remote 启动。

真实令牌只放在被 Git 忽略且权限为 `600` 的主机环境文件中，不要粘贴进聊天、Issue、
日志或 Git 提交。

## 状态与日志

```bash
systemctl status ai-remote-upload.service
systemctl status codex-remote.service
systemctl is-enabled ai-remote-upload.service
systemctl is-enabled codex-remote.service
systemctl is-active ai-remote-upload.service
systemctl is-active codex-remote.service
journalctl -u ai-remote-upload.service -n 100 --no-pager
journalctl -u codex-remote.service -n 100 --no-pager
```

持续查看日志：

```bash
journalctl -u ai-remote-upload.service -f
journalctl -u codex-remote.service -f
```

本机健康检查：

```bash
BACKEND_PORT=3000 # 替换为环境文件中的实际 CODEX_REMOTE_PORT
curl --fail --show-error "http://127.0.0.1:${BACKEND_PORT}/healthz"
```

目录 App Server 结束时，网页后端会主动退出，由 systemd 的 `Restart=on-failure`
拉起。单个会话 Worker 异常退出只会把该任务标记为 `failed`，不会带走 HTTP 服务或
其他 Worker。服务反复重启时，应先看日志中的 App Server/Worker 错误，而不只是检查
网页入口。

## 更新

在没有活动任务时更新：

```bash
git pull --ff-only
npm ci
npm run typecheck
npm test
systemctl restart ai-remote-upload.service
systemctl restart codex-remote.service
systemctl is-active ai-remote-upload.service
systemctl is-active codex-remote.service
BACKEND_PORT=3000 # 替换为环境文件中的实际 CODEX_REMOTE_PORT
curl --fail --show-error "http://127.0.0.1:${BACKEND_PORT}/healthz"
```

根据安装目录权限，其中部分命令可能需要以服务账户或管理员身份运行。重启会断开
浏览器连接；`running` 和 `waiting_for_permission` 会在新进程启动时明确标记为
`interrupted`，尚未启动的 `queued` 消息会继续调度。仍建议等活动任务完成后更新。

升级 Codex CLI 后也应运行同样的检查。`src/generated/` 中的类型与生成它们的 Codex
版本绑定；若协议变化导致类型或测试失败，应先重新生成类型并审查差异，不要只关闭
类型检查。

## 项目白名单

`config/projects.json` 是本地文件并被 Git 忽略；公开仓库只提供
`config/projects.example.json`。每一项配置一个“项目根目录”，网页列出它下面第一层
的普通文件夹。

不要把 `/`、整个用户主目录或包含秘密的宽泛目录配置成项目根目录。项目根目录只
限制浏览器可选择的 cwd 和可恢复会话；Codex 最终能访问哪些文件，还取决于服务账户
权限及当前 Codex 权限 profile。

修改项目配置后需要重启服务。

## 状态文件与备份

`CODEX_REMOTE_STATE_FILE` 指向回收站登记文件。它只包含 thread ID、项目 ID、删除
时间和恢复目标，不包含会话标题或正文。文件会在第一次使用回收站时创建，权限应只
允许服务账户访问。

`CODEX_REMOTE_WORK_STATE_FILE` 指向 Worker SQLite 状态库。它包含已接受消息、任务
状态、附件公开元数据、脱敏后的流事件、工具输出和中断原因，应视作敏感对话数据，
只允许服务账户访问。SQLite 使用 WAL；不要在服务运行时只复制主数据库文件而漏掉
尚未 checkpoint 的 `-wal`。可靠做法是在无活动任务时停止服务后复制数据库，或使用
SQLite 的在线备份能力。

`AI_REMOTE_UPLOAD_ROOT` 指向共享附件服务的数据目录，默认是
`~/.local/share/ai-remote/uploads`。其中同时包含原始附件和索引数据库，属于敏感数据；
备份时应复制整个目录并保持 `0700`/`0600` 权限，不要只复制数据库，也不要把附件的
绝对路径写进浏览器状态、公开日志或错误响应。

迁移主机时，如需保留回收站剩余保留天数、排队消息和中断记录，应同时迁移这两个
状态文件。Codex 原生会话和登录状态仍属于 Codex 自己的数据，应按所用 Codex CLI
版本的方式单独迁移。

## Origin 与反向代理

默认只允许与 `Host` 或 `X-Forwarded-Host` 同源的浏览器 WebSocket。正常保留 Host
的 Tailscale Serve、Caddy 和 Nginx 配置不需要额外白名单。

只有入口确实改写 Host，并且日志出现“拒绝了来源不匹配的 WebSocket 升级请求”时，
才把浏览器地址的完整 Origin 加入 `CODEX_REMOTE_ALLOWED_ORIGINS`。多个值用逗号
分隔，不要使用宽泛通配符。

## 发布 PWA 静态文件

网页后端使用严格静态文件白名单。新增或重命名 `public/` 文件时需要一起完成：

1. 在 `src/server/http-server.ts` 的 `STATIC_FILES` 中登记 URL、文件名和 Content-Type；
2. 在 `src/server/http-server.test.ts` 中验证新 URL 返回 200；
3. 如果文件属于离线外壳，把带版本号的 URL 加入 `public/sw.js` 的 `APP_SHELL`；
4. 同步更新 `public/index.html` 的资源版本和 Service Worker 缓存名；
5. 运行 `npm run typecheck` 和 `npm test`。

静态文件内容按请求读取。只改已有静态文件内容时通常不要求重启 Node 服务；新增
静态路由或修改后端代码时必须重启。

## 故障判断

网页打不开时分层检查：

1. 实际 `CODEX_REMOTE_PORT` 的回环 `/healthz` 是否成功；
2. `codex-remote.service` 和 `ai-remote-upload.service` 是否都为 `active`；
3. HTTPS 入口是否正确转发到 `127.0.0.1:<CODEX_REMOTE_PORT>`；
4. 防火墙、DNS 或 tailnet ACL 是否允许访问；
5. 浏览器是否使用 `https://`，WebSocket 是否使用 `wss://`。

网页能打开但无法登录时：

- “访问令牌不正确”：核对浏览器保存值与主机环境文件；
- WebSocket 被拒绝：检查日志中的 Origin/Host；
- 页面脚本未启动：检查 `boot.js`、`app.js` 和依赖资源是否返回 200；
- 更新后仍像旧版本：彻底关闭已安装 PWA，再从 HTTPS 地址重新打开。

### SSH 无法恢复已有会话

每个正在执行的会话由自己的 App Server Worker 持有 writer。页面关闭不会终止已经
接受的任务；等该任务完成且队列为空后，Worker 会立即退出并释放目标 writer。其他
浏览器页面和其他会话不会延迟这一步。

如果目标会话长时间仍报告 active writer，先在网页会话列表确认它是否仍为“运行中”，
再查看服务日志中的 Worker 状态。不要用 SSH CLI 与网页 Worker 同时修改同一项目。
确实需要强制接管时，先停止 Codex Remote 服务：

```bash
sudo systemctl stop codex-remote.service
```

停止服务会断开全部网页连接、中断仍在执行的 Worker，并终止它们的独立进程组，从而
释放 writer。确认服务已经停止后，再从 Codex CLI 恢复原会话。需要重新启用网页端时
先退出该 CLI 会话，再执行：

```bash
sudo systemctl start codex-remote.service
```

不要使用 `pkill codex` 或类似的宽泛进程匹配命令；它可能同时终止 SSH 中正在运行的
Codex CLI 或主机上的其他 App Server 实例。
