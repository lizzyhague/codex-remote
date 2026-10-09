# 运维说明

下面的 `3000` 都要换成环境文件里实际的 `CODEX_REMOTE_PORT`。

## 更新

后端和前端作为一个版本切换：服务在开始监听前读定整套前端，之后工作树里的改动不会
交给正在运行的进程，重启才整体换新。所以可以在运行中的工作树里拉取和验证，但只有
验证通过才重启。没有活动任务时更新：

```bash
previous=$(git rev-parse HEAD)
git pull --ff-only
npm ci --include=dev
npm run typecheck && npm test
```

验证失败时不要重启，先把工作树退回原版本，免得进程被意外拉起时装上半升级的代码：

```bash
git reset --hard "$previous"
npm ci --include=dev
```

验证通过后重启。Linux：

```bash
sudo systemctl restart codex-remote.service
curl --fail --show-error http://127.0.0.1:3000/healthz
```

macOS：`sudo launchctl kickstart -k system/<你的 label>`，再做同样的健康检查。

更新或停止本服务时，不要捎带更新、停止或重启 `ai-remote-upload`。附件存储的备份和
恢复见独立上传服务的运维说明。

上传服务卡住时，单次附件上传 30 秒没有任何进展或总共超过 10 分钟就会失败，页面显示
“共享上传服务响应超时”。停止本服务时，在途上传会被取消并提示稍后重试，不会拖住停止。
上传服务的原始错误文字只写进本服务日志，页面只显示本服务自己的说明。

Node 直接跑 TypeScript，没有构建步骤。重启会断开浏览器连接：`running` 和
`waiting_for_permission` 会被标成 `interrupted`，`queued` 的继续调度；关闭时仍在启动、
尚未向 Codex 提交这一轮的任务也保持 `queued`。

## Codex CLI 与 App Server 协议升级

[`codex-protocol.json`](../codex-protocol.json) 记录项目最近完整验证过的 Codex CLI 版本、业务
实际 import 的输出目录 `src/generated/`，以及生成器是否包含完整 experimental surface。
版本号是已验证事实，不是运行时限制；用户可以自行更新 Codex CLI，Codex Remote 不会因版本
不同而拒绝启动或检查协议。当前生成选择为 false；运行时仍为已采用的方法设置
`experimentalApi: true`，两者不是同一个开关。不要在 README、运维命令或 generated 文件里
另维护一份已验证版本号。

在不被运行中服务读取的隔离工作树或分支里升级：

1. 安装要验证的 CLI；如果候选可执行文件不在默认 `PATH`，临时用
   `CODEX_BIN=/absolute/path/to/codex` 指定。入口使用当前安装的 Codex CLI，不要为了通过版本
   检查而降级用户的 CLI。
2. 运行 `npm run codex:types -- --write`。入口会记录 `codex --version`，再使用空的临时
   `CODEX_HOME`，按 manifest 的 `experimental` 值决定是否传 `--experimental`；它会精确替换
   `src/generated/`，不会把文件写到另一个未被 import 的目录，也不会覆盖该目录已有的未知改动。
3. 用 `git diff -- src/generated` 审查新增、删除和字段变化。尤其重新核对
   本项目实际调用的方法、server request / notification 联合、experimental 方法，以及此前
   未采用的宿主能力是否变得可达；不要手工裁剪完整生成结果。
4. 再运行 `npm run codex:types`、`npm run typecheck` 和 `npm test`。第一条会在隔离目录重生成并
   逐字节比较，后两条只验证仓库类型和 fake transport，不能单独证明真实协议兼容。
5. 运行 `npm run codex:protocol`。它连接当前安装版本的真实 App Server，使用 Remote
   实际的 `experimentalApi` 初始化，并查询 `model/list` 与 `permissionProfile/list`；不会创建
   thread、不会启动 turn，也不会调用模型。
6. 上述检查都通过后，再把 manifest 的 `verifiedCodexCliVersion` 改成这次验证的版本，
   与经过审查的 `src/generated/` 一起提交。

会调用模型的端到端 smoke（当前是 `npm run smoke:attachments`）另算：只在测试实例、共享上传
服务、项目配置和登录状态准备好，而且明确允许产生真实模型调用时运行。它不能被前面的无模型
协议检查暗中带上，也不能把没运行写成已通过。协议变更完成后，再按普通更新流程把前后端作为
一个版本切换。

## 状态和日志

Linux：

```bash
systemctl status codex-remote.service
journalctl -u codex-remote.service -n 100 --no-pager
journalctl -u codex-remote.service -f
```

macOS：看运行用户日志目录下的 `codex-remote.log` 和 `codex-remote.error.log`。

目录 App Server 结束时网页后端会主动退出，由 `Restart=on-failure` 拉起。启动阶段（目录
App Server 初始化和启动时的回收站清理）两分钟内没能开始监听，也会以失败退出，日志里是
“启动超过 120 秒仍未就绪”，未完成的永久删除留到下次启动续做。启动期间或运行中收到
`SIGINT`/`SIGTERM` 属于计划内停止，即使目录 App Server 同时被信号结束，退出码也保持 0。单个会话
Worker 异常退出只会把那个任务标成 `failed`，不影响 HTTP 服务和其它 Worker。服务反复
重启时先看日志里的 App Server / Worker 错误，别只盯着网页入口。

## 登录

浏览器把令牌交给 `/auth/login`，服务签发 `HttpOnly`、`Secure`、`SameSite=Strict` 的
签名 cookie，WebSocket、附件上传和文件查看共用它。cookie 不依赖内存会话表，重启服务
不会让已登录设备退出；换 `CODEX_REMOTE_TOKEN` 会立即让全部旧 cookie 失效。

## 项目白名单

`config/projects.json` 被 Git 忽略，公开仓库只有 `.example`。每项配置一个项目根目录，
网页列出它下面第一层的普通文件夹。root ID 和经 `realpath` 解析后的根目录都必须唯一，
否则服务会拒绝启动；不同 root 下的同名项目在网页中显示 root ID 作为区分。改完要重启服务。

项目根目录限制浏览器能选的 cwd、能恢复的会话和文件查看范围，但 Codex 最终能碰哪些
文件还取决于服务账户权限和当前 Codex 权限 profile。

## 查看项目文件

会话可以交付 `/view?path=<URL 编码的绝对路径>` 链接。`/raw` 只读启动时经 `realpath`
解析的项目根目录，只接受 `.md` 和常见图片后缀；相对路径、目录、源码、符号链接逃逸
一律 404，不提供下载和目录浏览。需要登录 cookie，响应禁止缓存并带 `nosniff` 和沙箱
CSP。

## Codex Remote 辅助状态与备份

本节只覆盖 Codex Remote 为网页、队列、回收站和附件显示维护的辅助状态。Codex 自己仍是原生
thread 与完整历史的权威；下面的文件不包含那些原生 thread，本项目也不会完整备份或恢复 Codex
原生 thread。没有 Codex 官方保证和经过验证的恢复流程时，不要把复制其内部数据目录写成完整
会话备份方案。项目白名单、服务环境、登录凭据和独立上传服务同样不在下表中，要按各自来源恢复。

| 变量或路径 | 内容 | 敏感度 |
| --- | --- | --- |
| `CODEX_REMOTE_STATE_FILE` | 回收站登记：thread ID、项目 ID、删除时间、恢复目标、移入 / 恢复 / 永久删除阶段 | 低 |
| `CODEX_REMOTE_MARKS_FILE` | 钉住会话记录；未设置时与回收站同目录的 `marks.json` | 低 |
| `CODEX_REMOTE_SETTINGS_FILE` | 应用设置 JSON：附加 Developer 指令、新会话默认模型、思考强度与权限；未设置时与回收站同目录的 `settings.json` | 中，按用户指令对待 |
| `CODEX_REMOTE_WORK_STATE_FILE` | Worker SQLite：已接受消息、任务状态、脱敏事件、工具输出 | 高，按对话数据对待 |
| Worker 状态目录下的 `attachment-index/` | 会话附件显示索引：附件 ID、原名和本机真实路径 | 高，按本机路径与附件元数据对待 |

表中的 JSON 文件和附件索引写入后都会同步文件和所在目录，同步成功才算保存完成；
状态目录要放在支持目录 `fsync` 的本地文件系统上。任一环节失败时操作按失败报告，
不留下临时文件；永久删除的删除凭据没有保存完成时，不会去删除 Codex 会话。
回收站登记里出现 `trashing` 或 `restoring` 阶段后，不认识这两个阶段的旧版本无法读取
该文件；回退版本前先确认登记里已经没有这两个阶段（启动和每日清理成功后会把它们推进完）。

SQLite 用 WAL，不要在服务运行时只复制主库文件而漏掉 `-wal`。可靠做法是无活动任务时
停服务再复制。备份 Remote 辅助状态时应同时保存表中的 JSON 文件、Worker SQLite 和整个
`attachment-index/` 目录。附件本体不在本仓库的数据目录里，备份独立上传服务时按它自己
的运维说明。恢复后先核对文件所有者和权限、项目白名单、环境里的兼容 CLI 版本，再启动并检查
日志与 `/healthz`；这仍只恢复 Remote 辅助状态，不改变上面对 Codex 原生 thread 的边界。

## 新增前端文件

`public/` 不是目录服务，是白名单。新增或改名前端文件时要在
`src/server/http-server.ts` 的 `STATIC_FILES` 里登记 URL、文件名和 Content-Type，并在
`http-server.test.ts` 里验证返回 200。脚本和样式由服务端按内容生成 `/assets/<哈希>/`
地址，保存在 `public/.web-assets/`；只改已有文件内容不必再改 HTML 版本号或 Service
Worker 缓存名。任何前端或后端改动都要重启才生效。

`.web-assets/` 由服务自己管理：每次启动保留当前版本和最近两次启动用过的旧版本，更早的
自动删除，已打开的旧页面在接下来两次发布内仍能取到资源。部署时不要手工清空这个目录。
浏览器的离线缓存同样只保留当前离线页和上一套离线页的资源。

## Origin 与反向代理

默认只接受与 `Host` 或 `X-Forwarded-Host` 同源的请求。保留 Host 的 Tailscale Serve、
Caddy、Nginx 都不用额外配置。只有日志里出现"拒绝了来源不匹配的 WebSocket 升级请求"
时，才把完整 Origin 加进 `CODEX_REMOTE_ALLOWED_ORIGINS`，逗号分隔，不要用通配符。

## 排错

网页打不开，从里往外查：回环 `/healthz` → 两个服务是否 `active` → HTTPS 入口是否转到
正确的回环端口 → 防火墙、DNS 或 tailnet ACL。

能打开但登录不了：令牌不对就核对环境文件；WebSocket 被拒就看日志里的 Origin 和
Host；页面脚本没启动就看 `boot.js`、`app.js` 是不是都返回 200。

联网且部署完整时，普通刷新即可加载当前页面及其对应的脚本、样式，不必关闭已安装的
PWA。手机可在聊天列表、会话列表顶部或标题栏空白处下拉刷新。页面不会因为
Service Worker 更新而自动重载。离线只能打开最近一次完整缓存的外壳，会话功能仍需联网。
