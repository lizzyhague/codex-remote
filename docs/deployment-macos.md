# macOS 常驻部署

本文说明在一台 macOS 主机（包括 Mac mini）上把 Codex Remote 作为独立实例运行。
Linux 使用 systemd，见[运维说明](operations.md)。两种部署共用业务代码，但各自保存
配置、令牌、Codex 登录和运行状态；不要让两台主机共用同一个可写状态目录。

## 前提与只读检查

- macOS 主机使用固定且受信任的非 root 运行用户；
- Node.js 24 或更新版本和 Codex CLI 已安装；
- 运行用户已经登录 Codex，并能读写准备开放的项目；
- 已选择 [Tailscale Serve](deployment-tailscale.md) 或受控的公网 HTTPS 入口。

先以最终运行用户检查真实值，不要从 Homebrew 架构或用户名推测路径：

```bash
sw_vers
uname -m
id
command -v node
node --version
command -v codex
codex --version
printf '%s\n' "$HOME" "$PATH"
```

## 创建实例配置

```bash
npm ci
cp config/projects.example.json config/projects.json
cp deploy/codex-remote.env.example deploy/codex-remote.env
cp deploy/ai-remote-upload.env.example deploy/ai-remote-upload.env
cp deploy/launchd/codex-remote.plist.example deploy/launchd/codex-remote.plist.local
cp deploy/launchd/ai-remote-upload.plist.example deploy/launchd/ai-remote-upload.plist.local
chmod 600 config/projects.json deploy/codex-remote.env deploy/ai-remote-upload.env
```

在 `config/projects.json` 中只配置必要的项目根目录。用 `openssl rand -hex 32` 为该实例
生成独立令牌并写入 `deploy/codex-remote.env`，不要写入 plist、Git 或聊天。显式设置一个
未占用的 `CODEX_REMOTE_PORT`。如果主目录很长，可在两个环境文件中把
`AI_REMOTE_UPLOAD_SOCKET` 设为同一个较短的绝对路径；父目录必须只允许运行用户访问。

先在两个终端分别运行下面的命令，再执行 `npm run typecheck`、`npm test` 和回环健康
检查。确认基本流程后再安装常驻服务。

```bash
node --env-file=deploy/ai-remote-upload.env src/shared-upload/main.ts
node --env-file=deploy/codex-remote.env src/server/main.ts
```

## 填写并安装 LaunchDaemon

两份 `.plist.local` 需要替换：

| 占位符 | 内容 |
| --- | --- |
| `__RUN_USER__` / `__RUN_GROUP__` | `id -un` / `id -gn` 的结果 |
| `__RUN_HOME__` | 运行用户的 HOME 绝对路径 |
| `__APP_DIR__` | 当前仓库绝对路径 |
| `__NODE_BIN__` | `command -v node` 的绝对路径 |
| `__RUNTIME_PATH__` | 包含 Node、Codex 和系统命令的完整 PATH |
| `__ENV_FILE__` / `__UPLOAD_ENV_FILE__` | 两个环境文件的绝对路径 |
| `__LOG_DIR__` | 运行用户可写、其他用户不可读的日志目录 |
| `__REMOTE_SERVICE_LABEL__` | 例如 `io.example.codex-remote` |
| `__UPLOAD_SERVICE_LABEL__` | 例如 `io.example.ai-remote-upload` |

每个实例使用不同 label。先创建日志目录并确认没有占位符，再校验 plist：

```bash
mkdir -p "$HOME/Library/Logs/codex-remote"
chmod 700 "$HOME/Library/Logs/codex-remote"
if rg -n '__[A-Z_]+__' deploy/launchd/*.plist.local; then exit 1; fi
plutil -lint deploy/launchd/*.plist.local
```

以下步骤需要管理员权限，并会启动服务：

```bash
sudo install -o root -g wheel -m 0644 deploy/launchd/ai-remote-upload.plist.local \
  /Library/LaunchDaemons/io.example.ai-remote-upload.plist
sudo install -o root -g wheel -m 0644 deploy/launchd/codex-remote.plist.local \
  /Library/LaunchDaemons/io.example.codex-remote.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.example.ai-remote-upload.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.example.codex-remote.plist
```

上面的文件名和 label 只是例子，必须与 plist 实际值对应。两个服务不建立启动顺序：
上传服务暂时不可用时，纯文本功能仍可启动，附件操作会明确失败。

## 验证、运维与卸载

```bash
sudo launchctl print system/io.example.ai-remote-upload
sudo launchctl print system/io.example.codex-remote
curl --fail --show-error http://127.0.0.1:3000/healthz
lsof -nP -iTCP:3000 -sTCP:LISTEN
tail -F "$HOME/Library/Logs/codex-remote/"*.log
```

把 `3000` 和 label 换成实例实际值。`lsof` 应只显示 `127.0.0.1`，然后再验证实际 HTTPS、
错误令牌拒绝、正确令牌登录、会话和附件。重启可使用 `launchctl kickstart -k`；更新前先
等活动任务完成，再更新代码、执行测试并逐项 kickstart。

卸载会中断该 Mac 实例上的连接和活动 Worker：

```bash
sudo launchctl bootout system/io.example.codex-remote
sudo launchctl bootout system/io.example.ai-remote-upload
```

卸载 plist 不会删除项目、Codex 会话、Remote SQLite 或附件。确认不再需要这些数据后
再单独处理，不要用宽泛的进程名终止 Codex。
