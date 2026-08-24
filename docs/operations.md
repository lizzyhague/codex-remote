# 运维说明

本文说明 Linux 主机上的常驻运行、更新、日志和迁移。网络入口请分别参阅：

- [Tailscale Serve 私网部署](deployment-tailscale.md)
- [公网 HTTPS 部署](deployment-public.md)

由 AI 协助部署时，AI 还必须遵守 [AI 部署与交接规范](deployment-ai.md)。不能只以
`systemctl is-active` 或 `/healthz` 成功就宣布部署完成；还要验证实际 HTTPS 入口、
浏览器登录和后端监听地址，并向用户完成安全与使用规则交接。

Codex Remote 固定监听 `127.0.0.1`，systemd 单元不依赖具体入口。

## systemd 模板

仓库中的 `deploy/codex-remote.service` 和 `deploy/codex-remote.env.example` 是模板，
不能假设每台主机的用户名、Node.js、Codex CLI 和代码路径相同。安装前至少核对：

- `User`、`Group` 和 `HOME`；
- `WorkingDirectory` 与 `ExecStart`；
- Node.js 和 `CODEX_BIN` 的绝对路径；
- 项目配置、状态目录及其文件权限；
- 服务账户是否已经登录 Codex，以及是否能读写允许的项目。

建议使用专用的非 root 系统账户。该账户的 `HOME` 保存 Codex 自己的登录和会话数据，
因此不能把 `ProtectHome=true` 等会阻断这些目录的 systemd 限制直接照搬进来。

准备环境文件：

```bash
cp deploy/codex-remote.env.example /etc/codex-remote.env
chmod 600 /etc/codex-remote.env
```

把项目配置复制到环境文件中声明的位置，并改为实际绝对路径：

```bash
cp config/projects.example.json /etc/codex-remote-projects.json
```

安装并启动单元：

```bash
cp deploy/codex-remote.service /etc/systemd/system/codex-remote.service
systemctl daemon-reload
systemctl enable --now codex-remote.service
```

这些命令通常需要管理员权限。先编辑模板再启动，不要直接依赖示例中的
`/opt/codex-remote`、`/usr/bin/node` 或 `/usr/local/bin/codex`。

真实令牌只放在主机环境文件中，不要粘贴进聊天、Issue、日志或 Git 提交。

## 状态与日志

```bash
systemctl status codex-remote.service
systemctl is-enabled codex-remote.service
systemctl is-active codex-remote.service
journalctl -u codex-remote.service -n 100 --no-pager
```

持续查看日志：

```bash
journalctl -u codex-remote.service -f
```

本机健康检查：

```bash
curl http://127.0.0.1:8787/healthz
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
systemctl restart codex-remote.service
systemctl is-active codex-remote.service
curl http://127.0.0.1:8787/healthz
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
状态、脱敏后的流事件、工具输出和中断原因，应视作敏感对话数据，只允许服务账户
访问。SQLite 使用 WAL；不要在服务运行时只复制主数据库文件而漏掉尚未 checkpoint
的 `-wal`。可靠做法是在无活动任务时停止服务后复制数据库，或使用 SQLite 的在线
备份能力。

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

1. `curl http://127.0.0.1:8787/healthz` 是否成功；
2. systemd 服务是否为 `active`；
3. HTTPS 入口是否正确转发到 `127.0.0.1:8787`；
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
