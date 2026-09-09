# 运维说明

下面的 `3000` 都要换成环境文件里实际的 `CODEX_REMOTE_PORT`。

## 更新

没有活动任务时更新，验证通过再重启：

```bash
git pull --ff-only
npm ci --include=dev
npm run typecheck && npm test
```

Linux：

```bash
sudo systemctl restart codex-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

macOS：`sudo launchctl kickstart -k system/<你的 label>`，再做同样的健康检查。

更新或停止本服务时，不要捎带更新、停止或重启 `ai-remote-upload`。附件存储的备份和
恢复见独立上传服务的运维说明。

Node 直接跑 TypeScript，没有构建步骤。重启会断开浏览器连接：`running` 和
`waiting_for_permission` 会被标成 `interrupted`，`queued` 的继续调度。

升级 Codex CLI 后也要跑一遍上面的检查。`src/generated/` 的类型跟生成它的 Codex 版本
绑定，协议变了要重新生成并审查差异，不要直接关掉类型检查。

## 状态和日志

Linux：

```bash
systemctl status codex-remote.service
journalctl -u codex-remote.service -n 100 --no-pager
journalctl -u codex-remote.service -f
```

macOS：看运行用户日志目录下的 `codex-remote.log` 和 `codex-remote.error.log`。

目录 App Server 结束时网页后端会主动退出，由 `Restart=on-failure` 拉起。单个会话
Worker 异常退出只会把那个任务标成 `failed`，不影响 HTTP 服务和其它 Worker。服务反复
重启时先看日志里的 App Server / Worker 错误，别只盯着网页入口。

## 登录

浏览器把令牌交给 `/auth/login`，服务签发 `HttpOnly`、`Secure`、`SameSite=Strict` 的
签名 cookie，WebSocket、附件上传和文件查看共用它。cookie 不依赖内存会话表，重启服务
不会让已登录设备退出；换 `CODEX_REMOTE_TOKEN` 会立即让全部旧 cookie 失效。

## 项目白名单

`config/projects.json` 被 Git 忽略，公开仓库只有 `.example`。每项配置一个项目根目录，
网页列出它下面第一层的普通文件夹。改完要重启服务。

项目根目录限制浏览器能选的 cwd、能恢复的会话和文件查看范围，但 Codex 最终能碰哪些
文件还取决于服务账户权限和当前 Codex 权限 profile。

## 查看项目文件

会话可以交付 `/view?path=<URL 编码的绝对路径>` 链接。`/raw` 只读启动时经 `realpath`
解析的项目根目录，只接受 `.md` 和常见图片后缀；相对路径、目录、源码、符号链接逃逸
一律 404，不提供下载和目录浏览。需要登录 cookie，响应禁止缓存并带 `nosniff` 和沙箱
CSP。

## 状态文件与备份

| 变量 | 内容 | 敏感度 |
| --- | --- | --- |
| `CODEX_REMOTE_STATE_FILE` | 回收站登记：thread ID、项目 ID、删除时间、恢复目标 | 低 |
| `CODEX_REMOTE_WORK_STATE_FILE` | Worker SQLite：已接受消息、任务状态、脱敏事件、工具输出 | 高，按对话数据对待 |

SQLite 用 WAL，不要在服务运行时只复制主库文件而漏掉 `-wal`。可靠做法是无活动任务时
停服务再复制。附件本体不在本仓库的数据目录里，备份独立上传服务时按它自己的运维说明。

## 新增前端文件

`public/` 不是目录服务，是白名单。新增或改名前端文件时要在
`src/server/http-server.ts` 的 `STATIC_FILES` 里登记 URL、文件名和 Content-Type，在
`http-server.test.ts` 里验证返回 200，并把带版本号的 URL 加进 `public/sw.js` 的
`APP_SHELL`、同步 `index.html` 的资源版本和 Service Worker 缓存名。只改已有文件内容
不用重启，新增静态路由或改后端代码必须重启。

## Origin 与反向代理

默认只接受与 `Host` 或 `X-Forwarded-Host` 同源的请求。保留 Host 的 Tailscale Serve、
Caddy、Nginx 都不用额外配置。只有日志里出现"拒绝了来源不匹配的 WebSocket 升级请求"
时，才把完整 Origin 加进 `CODEX_REMOTE_ALLOWED_ORIGINS`，逗号分隔，不要用通配符。

## 排错

网页打不开，从里往外查：回环 `/healthz` → 两个服务是否 `active` → HTTPS 入口是否转到
正确的回环端口 → 防火墙、DNS 或 tailnet ACL。

能打开但登录不了：令牌不对就核对环境文件；WebSocket 被拒就看日志里的 Origin 和
Host；页面脚本没启动就看 `boot.js`、`app.js` 是不是都返回 200。

更新后仍像旧版本：彻底关闭已安装的 PWA，再从 HTTPS 地址重新打开。
