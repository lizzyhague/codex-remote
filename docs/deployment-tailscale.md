# 使用 Tailscale Serve 部署

> 如果由 AI 协助部署，AI 必须先阅读 [AI 部署与交接规范](deployment-ai.md)，先只读
> 核对环境并取得用户对修改文件、安装软件和管理员权限的明确同意。本页只说明
> Tailscale 路径，不能代替部署前检查和部署后交接。

这条路径适合只让自己或 tailnet 中明确授权的设备访问。Codex Remote 仍监听
`127.0.0.1:8787`，Tailscale Serve 负责 tailnet 内的 HTTPS 和访问控制。

Tailscale Serve 官方文档：https://tailscale.com/docs/features/tailscale-serve

## 前提

- Codex Remote 已在主机上启动；
- 主机和访问设备均已安装并登录 Tailscale；
- tailnet 的访问控制规则允许访问这台主机。

先从主机确认后端只在回环地址可用：

```bash
curl http://127.0.0.1:8787/healthz
```

## 建立 HTTPS 入口

当前 Tailscale CLI 可以直接把 tailnet 内的 HTTPS 根路径反向代理到本机端口：

```bash
tailscale serve --bg http://127.0.0.1:8787
```

首次使用时，CLI 可能会要求在浏览器中启用 tailnet HTTPS。根据系统的 Tailscale
安装方式，这条命令也可能需要管理员权限。

查看地址和转发状态：

```bash
tailscale serve status
```

浏览器打开状态输出中的 `https://...ts.net/` 地址，再输入
`CODEX_REMOTE_TOKEN`。正常情况下不需要设置 `CODEX_REMOTE_ALLOWED_ORIGINS`，因为
Serve 会保留原始 Host 信息。

## 安全边界

Tailscale Serve 只把服务提供给 tailnet，不是公网入口。Tailscale 身份控制网络访问，
Codex Remote 的令牌负责应用登录，两层保护相互独立。

不要把 `tailscale serve` 换成 `tailscale funnel` 后仍当作私网部署。Funnel 会把入口
开放到整个互联网，需要按[公网部署](deployment-public.md)的风险模型处理。

## 排查

依次检查：

```bash
curl http://127.0.0.1:8787/healthz
tailscale status
tailscale serve status
```

网页能打开但 WebSocket 被拒绝时，查看 Codex Remote 日志中的 Origin 和 Host。只有
反向代理确实改写 Host 时，才把浏览器地址的完整 Origin 加入
`CODEX_REMOTE_ALLOWED_ORIGINS`。

某些系统代理会截获 `.ts.net` 请求。此时应在代理软件中绕过 `*.ts.net` 和 Tailscale
CGNAT 地址段 `100.64.0.0/10`，具体设置取决于所用代理。
