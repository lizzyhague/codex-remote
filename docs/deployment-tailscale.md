# 使用 Tailscale Serve 部署

> 如果由 AI 协助部署，AI 必须先阅读 [AI 部署与交接规范](deployment-ai.md)，先只读
> 核对环境并取得用户对修改文件、安装软件和管理员权限的明确同意。本页只说明
> Tailscale 路径，不能代替部署前检查和部署后交接。

这条路径适合只让自己或 tailnet 中明确授权的设备访问。Codex Remote 始终只监听
本机回环地址，Tailscale Serve 负责 tailnet 内的 HTTPS 和访问控制：

```text
浏览器 -> HTTPS:<入口端口> -> 127.0.0.1:<CODEX_REMOTE_PORT>
```

入口端口和后端端口是两项独立配置，不要求使用相同数字。仓库不为部署主机分配端口；
部署前应先查看该主机已有监听和 `tailscale serve status`，再选择未占用的值。

Tailscale Serve 官方文档：https://tailscale.com/docs/features/tailscale-serve

## 前提

- Codex Remote 已在主机上启动；
- 主机和访问设备均已安装并登录 Tailscale；
- tailnet 的访问控制规则允许访问这台主机；
- 已确定环境文件中的 `CODEX_REMOTE_PORT` 和准备使用的 HTTPS 入口端口。

以下命令用 `3000` 作为后端示例、`8443` 作为 HTTPS 入口示例。它们不是固定要求：

```bash
BACKEND_PORT=3000
HTTPS_PORT=8443
```

先确认后端健康，并且只监听回环地址：

```bash
curl --fail --show-error "http://127.0.0.1:${BACKEND_PORT}/healthz"
ss -ltn "sport = :${BACKEND_PORT}"
```

## 建立 HTTPS 入口

先查看当前主机已有的 Serve 配置，不要覆盖或删除其它服务入口：

```bash
tailscale serve status
```

为所选 HTTPS 端口建立到后端回环端口的反向代理：

```bash
tailscale serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${BACKEND_PORT}"
tailscale serve status
```

首次使用时，CLI 可能会要求在浏览器中启用 tailnet HTTPS。根据系统的 Tailscale
安装方式，这条命令也可能需要管理员权限。

状态中应清楚显示所选端口和目标，例如：

```text
https://<本机的-tailnet-DNS-名>:8443
└── proxy http://127.0.0.1:3000
```

浏览器打开状态输出中的实际 HTTPS 地址，再输入 `CODEX_REMOTE_TOKEN`。正常情况下
不需要设置 `CODEX_REMOTE_ALLOWED_ORIGINS`，因为 Serve 会保留原始 Host 信息。

## 安全边界

Tailscale Serve 只把服务提供给 tailnet，不是公网入口。Tailscale 身份控制网络访问，
Codex Remote 的令牌负责应用登录，两层保护相互独立。

不要把 `tailscale serve` 换成 `tailscale funnel` 后仍当作私网部署。Funnel 会把入口
开放到整个互联网，需要按[公网部署](deployment-public.md)的风险模型处理。

## 验证与排查

依次检查，其中端口应替换为本机实际值：

```bash
curl --fail --show-error "http://127.0.0.1:${BACKEND_PORT}/healthz"
tailscale status
tailscale serve status
curl --fail --show-error "https://<实际-tailnet-DNS-名>:${HTTPS_PORT}/healthz"
```

最后从另一台有权限的 tailnet 设备打开实际 HTTPS 地址，确认错误令牌不能登录、正确
令牌能加载预期项目，并确认浏览器使用 `wss://` WebSocket。

网页能打开但 WebSocket 被拒绝时，查看 Codex Remote 日志中的 Origin 和 Host。只有
反向代理确实改写 Host 时，才把浏览器地址的完整 Origin 加入
`CODEX_REMOTE_ALLOWED_ORIGINS`。

某些系统代理会截获 `.ts.net` 请求。此时应在代理软件中绕过 `*.ts.net` 和 Tailscale
CGNAT 地址段 `100.64.0.0/10`，具体设置取决于所用代理。
