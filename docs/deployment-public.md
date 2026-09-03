# 使用公网 HTTPS 部署

> 如果由 AI 协助部署，AI 必须先阅读 [AI 部署与交接规范](deployment-ai.md)，先只读
> 核对环境并取得用户对修改文件、安装软件和管理员权限的明确同意。公网部署扩大了
> 攻击面，AI 不得在用户没有明确选择这条路径时自行采用。

这条路径适合单个部署者通过普通浏览器访问自己的实例，不要求访问设备安装
Tailscale。它不把 Codex Remote 变成多人服务：所有浏览器仍共用一个应用令牌，
也没有账户、MFA、分用户吊销或审计系统。

公网入口只应由 HTTPS 反向代理提供。不要修改源码让 Node.js 监听 `0.0.0.0`，也不要
在防火墙中开放所选的后端回环端口。

## 风险

和 tailnet 内部署相比，公网地址会持续接收扫描、连接尝试和恶意流量。主要风险包括：

- 令牌泄露后，攻击者可以查看会话并驱动 Codex；
- Codex 的实际文件和命令权限取决于部署主机的 Codex 配置；
- 未认证连接和大量请求可能消耗主机资源；
- 恶意使用可能消耗 Codex 账户用量；
- 令牌保存在浏览器 `localStorage`，共享设备或同源脚本失陷会扩大泄露风险。

本项目的应用令牌使用高熵随机值时不依赖“密码复杂度”，但它仍是长期共享凭证，
不能代替完整的用户身份系统。

## 最低要求

- 使用权限边界明确的非 root Unix 用户运行 Codex 和 Codex Remote；如选择专用用户，
  应在该用户身份下单独安装、登录 Codex，并配置项目访问权限；
- 使用 `openssl rand -hex 32` 或等强度方式生成独立令牌；
- 只开放公网 `80/443`，后端保持监听 `127.0.0.1:<CODEX_REMOTE_PORT>`；
- 为域名启用有效 HTTPS，禁止明文远程访问；
- 项目根目录尽量窄，并保留 Codex 的受限权限；
- 在云防火墙、CDN 或反向代理层设置合理的连接和请求限制；
- 如入口面向不受控网络，建议再增加支持 WebSocket 的身份代理或零信任访问层。

## Caddy 示例

准备一个解析到 VPS 的域名，并确保公网可以访问 `80` 和 `443`。确认 Codex Remote
已经在回环地址运行。以下用默认开发端口 `3000` 举例；正式部署应替换为环境文件中的
实际 `CODEX_REMOTE_PORT`：

```bash
curl --fail --show-error http://127.0.0.1:3000/healthz
```

Caddyfile 的最小配置如下：

```caddyfile
codex.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 会为有效域名申请和续期 HTTPS 证书，其 `reverse_proxy` 原生支持 WebSocket。

Caddy HTTPS 文档：https://caddyserver.com/docs/quick-starts/https

Caddy 反向代理文档：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy

修改配置后，先验证再重载：

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy 会保留浏览器的 Host，并传递 `X-Forwarded-Host`，所以通常不需要设置
`CODEX_REMOTE_ALLOWED_ORIGINS`。使用其它反向代理时必须同时满足：

- 正确转发 WebSocket Upgrade；
- 保留原始 `Host` 或设置正确的 `X-Forwarded-Host`；
- 不允许外部客户端伪造受信任代理头绕过入口策略。

如果代理确实重写了 Host，把浏览器地址的完整 Origin 显式加入环境变量，例如：

```bash
CODEX_REMOTE_ALLOWED_ORIGINS=https://codex.example.com
```

## 上线前检查

```bash
curl https://codex.example.com/healthz
```

然后在浏览器中确认：

1. HTTP 自动跳转到 HTTPS；
2. 错误令牌无法登录；
3. 正确令牌可以加载项目列表；
4. 浏览器开发者工具中 WebSocket 使用 `wss://`；
5. VPS 公网地址无法直接访问实际后端回环端口；
6. 当前 Codex 权限不是无意设置成 full access。

公开 DNS 名称本身不是秘密。真正需要保护的是应用令牌、Codex 登录状态、项目内容和
服务账户可访问的其它本机数据。
