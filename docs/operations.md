# 运维说明

本文说明 Linux 主机上的常驻运行、更新、日志和迁移。网络入口请分别参阅：

- [Tailscale Serve 私网部署](deployment-tailscale.md)
- [公网 HTTPS 部署](deployment-public.md)

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

`codex app-server` 结束时，网页后端会主动退出，由 systemd 的
`Restart=on-failure` 拉起。服务反复重启时，应先看日志中 App Server 的 stderr，
而不只是检查网页入口。

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
浏览器连接，并中断仍在执行的任务。

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

迁移主机时，如需保留回收站剩余保留天数，应复制这个文件。Codex 会话和登录状态
属于 Codex 自己的数据，不由本项目备份；应按所用 Codex CLI 版本的方式单独迁移。

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
