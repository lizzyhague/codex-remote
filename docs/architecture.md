# 架构说明

Codex Remote 是单用户自托管的 PWA，用来在手机或电脑上控制主机上的 Codex CLI。
它解决的是高延迟下的手感问题：消息在浏览器本地编完再发，回复流式回来。

它不是通用终端，也不是把 Codex App Server 包一层直接开放——浏览器只看到为这个应用
设计的小协议。后端只监听 `127.0.0.1`，HTTPS 入口是独立的一层。

```text
浏览器 PWA → HTTPS 入口 → 127.0.0.1:<CODEX_REMOTE_PORT>
                              ├→ Unix socket 上的 ai-remote-upload（仅附件）
                              └→ 每个活动会话一个 codex app-server --stdio 子进程
```

## 模块

| 目录 | 负责什么 |
| --- | --- |
| `src/server` | HTTP 与 WebSocket 入口、cookie 鉴权、Origin 校验、静态资源、项目锁、文件查看 |
| `src/app-server` | 与 Codex App Server 的 JSONL 通信、目录服务、工具展示 |
| `src/workers` | 每个会话一个 Worker：启动、排队、退出、状态持久化 |
| `src/sessions` | 会话列表、历史分页、归档与回收站 |
| `src/approvals` | 接收 App Server 的审批请求并转给浏览器 |
| `src/commands` | 斜杠命令目录与执行 |
| `src/projects` | 项目白名单解析 |
| `src/shared-upload` | 独立项目 `ai-remote-upload` 的薄客户端 |
| `src/platform` | 平台差异（可用内存读取等） |
| `src/generated` | 由 Codex CLI 协议生成的类型，与具体 Codex 版本绑定 |
| `public/` | 前端 PWA：登录、项目与会话导航、编辑发送、流式显示、Markdown、斜杠菜单 |

Codex 自己是原生会话和完整历史的权威存储。Node 这边额外保存已接受的消息、任务
状态、脱敏后的浏览器事件、权限模式、中断原因，以及会话附件显示索引，用来支撑
"关掉页面任务继续跑"，并把已知附件路径从页面副本里换成原名。

## 会话与任务

消息被接受后即可关闭页面，任务在独立 Worker 中继续，直到完成、被停止、遇到无人处理
的审批，或 Worker 失败。重新打开会话时，已完成的历史从 Codex 恢复，运行中的部分输出
从事件日志重放。

同一项目同时只运行一个任务；任务控制权属于登录会话而不是某条 WebSocket，任意在线
设备都能看输出、点审批、停任务。默认最多同时两个 Worker，超出的消息先排队。

会话可以搜索、归档、移入回收站、恢复；回收站满 30 天后连 Codex 侧一起删除。运行中的
会话不能归档或删除。

## 权限与审批

只支持"本次允许"和"拒绝"，不创建长期授权规则。发给浏览器的审批只含审批 ID、类型、
文字理由、时间和网络目标，原始命令和内部 ID 不外传。

最后一个客户端断开后保留 10 秒：普通权限下宽限期结束仍有审批等待，会先拒绝再中断
整轮；Full access 可以自动处理执行和文件权限，但选择题、验证码、登录授权这类必须人
回答的输入永不自动应答，无人在线时同样中断。

## 斜杠命令

命令目录由后端下发，不写死在设备缓存里：`/compact`、`/model`、`/permissions`、
`/plan`、`/rename`、`/review`、`/rewind`、`/status`、`/usage`。输入框下方另有 `/`、
`rewind`、`usage`、`full access` 四个快捷入口。

`/model`、`/permissions`、`/plan` 只改当前会话的后续设置，不写 Codex 全局配置，任务
运行期间会被拒绝。

## 安全边界

- 只监听回环，入口挂掉也不会绑到公网网卡；App Server 从不绑定端口。
- WebSocket 升级前校验 Origin 和登录 cookie；令牌定时安全比较，换令牌立即失效全部 cookie。
- 项目必须落在白名单根目录的第一层文件夹内，恢复会话时核对 Codex 返回的 `cwd`。
- 浏览器拿不到主机绝对路径；系统抛出的带路径错误只写日志。
- 文件查看器只读白名单根目录内的 Markdown 和图片，不提供下载或目录浏览。
