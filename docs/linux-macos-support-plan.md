# Linux / macOS 通用适配修改方案

## 文档状态

本文最初是供维护者评审的实现方案。平台资源适配、双平台 CI 和 launchd 模板现已实现；
真实 Mac 硬件上的完整浏览器与服务生命周期验收仍需在发布前完成。
内容只描述开源项目本身，不记录任何具体部署主机的账户、路径、端口、网络拓扑或运行状态。

## 目标与边界

目标是在同一主分支中正式支持 Linux 和 macOS，而不是维护两个长期分叉的系统分支。
建议把平台差异集中在很薄的适配层和部署资源中：业务协议、浏览器、App Server 适配、
会话状态及安全边界继续共用一套实现。

首轮适配包括：

- Node.js 运行时在 Linux 和 macOS 上行为一致；
- Worker 内存门槛在两个平台上都能正常工作；
- App Server 子进程及其后代能够可靠退出；
- 共享附件服务的 Unix socket、权限和磁盘空间检查通过双平台验证；
- CI 同时覆盖 Linux 和 macOS；
- Linux 使用 systemd，macOS 使用 launchd，并分别提供模板和运维说明；
- README、架构和部署文档不再把 Linux 或 VPS 当成唯一运行环境。

本轮不包括：

- Windows 支持；
- 容器化或 Kubernetes；
- 把 Node 服务改成监听非回环地址；
- 自动迁移 Codex 登录数据、原生会话或 Codex Remote 状态；
- 代替部署者修改防火墙、DNS、Tailscale ACL 或反向代理；
- 为平台差异复制业务代码或建立长期 `linux`、`macos` 分支。

## 设计原则

### 一套业务代码，两套部署入口

运行时通过受控的平台适配模块处理必要差异。systemd 和 launchd 是不同的服务管理器，
它们应有独立模板和操作文档，不应通过复杂脚本伪装成同一种部署方式。

建议目录关系为：

```text
src/
  platform/                 # 少量运行时平台适配
deploy/
  systemd/                  # Linux 单元模板
  launchd/                  # macOS plist 模板
docs/
  deployment-linux.md
  deployment-macos.md
  operations.md             # 两个平台共用的行为和数据说明
```

现有 `deploy/*.service.example` 可以先保留原路径，避免一次适配同时制造无必要的文件移动；
待兼容版本稳定后，再单独决定是否整理到 `deploy/systemd/`。

### 保持现有安全边界

平台适配不得改变以下约束：

- HTTP 服务仍只监听 `127.0.0.1`；
- 远程访问仍必须经过受控的 HTTPS 入口；
- 应用令牌仍是必需的，且只能放在仓库外的受限配置文件中；
- Codex Remote 和共享附件服务使用同一个非 root Unix 账户；
- App Server 继续通过子进程 stdin/stdout 上的 JSONL 通信，不开放 App Server 网络端口；
- 项目白名单、服务账户权限和 Codex 权限 profile 继续共同构成执行边界。

OpenAI 官方文档说明 Codex CLI 可用于 macOS 和 Linux；App Server 的默认传输是 stdio
JSONL。App Server 及部分实验 API 不应被视为跨版本稳定接口，因此平台适配必须同时
保留 Codex CLI 版本验证和协议回归测试：

- [Codex CLI 官方文档](https://developers.openai.com/codex/cli)
- [Codex App Server 官方文档](https://developers.openai.com/codex/app-server)

## 当前兼容性审计

| 范围 | 当前情况 | 结论与动作 |
| --- | --- | --- |
| Node.js | `package.json` 要求 Node.js 24 或更新版本 | 两个平台统一使用 Node.js 24，并在 CI 固定主版本 |
| Codex App Server | 通过 `codex app-server --stdio` 启动 | 传输方式可共用；每个平台都要用实际 CLI 做 smoke test |
| Worker 内存门槛 | 已提取到 `src/platform/system-resources.ts` | Linux 读取 `/proc/meminfo`，macOS 使用 `os.freemem()`；仍需真实压力验收 |
| 子进程清理 | 使用 detached 进程组和负 PID 发送信号 | Linux、macOS 都是 POSIX，但必须在两端运行后代进程清理测试 |
| 共享附件 | 使用 Unix socket、`chmod`、原子重命名和 `statfs` | 原语可跨平台；需要验证 socket 路径长度、权限、配额和磁盘门槛 |
| SQLite | 使用 Node.js 内置 SQLite | 预计可共用；由 macOS CI 和真实运行环境验证 |
| 状态目录 | 默认使用 `~/.local/state` 与 `~/.local/share` | macOS 上可用；首轮不迁移到 `~/Library`，避免制造跨版本状态迁移 |
| 信号退出 | 监听 `SIGINT` 和 `SIGTERM` | 两个平台可共用，但要验证服务管理器停止时能够完整清理进程树 |
| 常驻服务 | systemd 与 LaunchDaemon 模板均已提供 | 仍需在真实主机验证开机启动、停止和失败重启 |
| CI | 已配置 Ubuntu 与 macOS 矩阵 | 合并后由 GitHub Actions 验证两个 runner |
| 文档措辞 | 通用界面和主要文档已改称“主机” | 公网 VPS 专属段落保留准确名称 |

## 代码修改方案

### 1. 提取主机资源适配层

新增 `src/platform/system-resources.ts`，把可用内存检测从
`src/workers/manager.ts` 移出。`SessionWorkerManager` 继续通过依赖注入接收检测函数，
避免平台判断散落到调度逻辑，也保留现有测试构造方式。

建议行为：

- Linux：继续解析 `/proc/meminfo` 中的 `MemAvailable`，保持已有调度语义；
- macOS：使用 Node.js 的 `os.freemem()` 作为首版保守指标，避免依赖 `vm_stat` 的文本
  格式、区域设置和外部命令路径；
- 读数无效或读取失败：返回 0，阻止启动新 Worker，并只记录一次明确诊断，避免队列
  重试时持续刷日志；
- 其它平台：明确报告尚不支持，而不是误称为内存不足；
- `CODEX_REMOTE_MIN_AVAILABLE_MEMORY_MIB=0` 继续表示显式关闭门槛，但文档应说明这样会
  失去 Worker 启动前的内存保护。

Linux 的 `MemAvailable` 与 macOS 的 `os.freemem()` 语义并不完全相同。首版不应伪造一个
精确等价值；应把它定义为“允许启动新 Worker 的保守资源预算”，并在真实 macOS 压力
测试后决定是否需要更精细的实现。若 `os.freemem()` 造成长期误拦截，再单独评估基于
原生系统接口的实现，而不是先引入脆弱的命令输出解析。

新增单元测试至少覆盖：

- Linux `MemAvailable` 的正常值、缺失字段和非法数字；
- macOS 路径使用注入的 `freemem` 返回值；
- 读取异常和未知平台的保守行为；
- 低于、等于和高于门槛时的调度结果；
- 门槛设为 0 时不因无法读取内存而阻塞。

### 2. 平台识别只用于诊断

Node 运行时平台以 `process.platform` 为准。App Server 初始化结果中的
`platformFamily` 和 `platformOs` 可以写入启动诊断，但不应在没有协议保证时与 Node
平台字符串做硬编码等值判断。这样既能帮助排查 CLI/宿主不一致，也不会依赖未承诺的
字符串取值。

启动日志应包含操作系统类别、Node.js 版本和 App Server 报告的平台，但不得包含令牌、
私有项目路径、Codex 凭证或会话内容。

### 3. 验证进程组，不预先重写

`src/app-server/client.ts` 当前依赖 POSIX detached 进程组：Worker 关闭时先结束组长，
再用负 PID 清理仍存活的后代。这一机制原则上适用于 Linux 和 macOS，但属于必须用真实
平台验证的关键生命周期逻辑。

首轮先让现有 `src/app-server/client.test.ts` 在 macOS CI 运行，特别保留“组长退出后后代
仍被清理”的用例。只有测试证明语义不同，才为 macOS 增加局部适配；不要把
`pkill codex`、按进程名清理或全局扫描作为替代方案。

还应补充以下验证：

- 正常完成后没有遗留 App Server 或工具子进程；
- `SIGTERM` 超时后升级为 `SIGKILL`；
- 组已经不存在时的错误不会误伤其它进程；
- 停止一个 Worker 不影响目录 App Server 或其它 Worker。

### 4. 验证 Unix socket 与存储原语

共享附件服务继续使用 Unix socket，不需要为 macOS 改成 TCP。实现和测试需要确认：

- 父目录为 `0700`、socket 及敏感文件为 `0600`；
- 默认路径和文档示例不会超过 macOS Unix socket 的路径限制；
- 服务异常退出后遗留 socket 能按现有策略安全恢复；
- `statfs` 在两个平台都能正确触发和解除磁盘空间门槛；
- 临时文件同步、原子重命名、租约续期和清理测试在 macOS CI 中通过。

如果部署者使用很长的主目录或安装路径，应在启动时给出可操作的 socket 路径错误，
并建议通过 `AI_REMOTE_UPLOAD_SOCKET` 选择更短的绝对路径；不要静默回退到不受保护的
公共临时目录。

### 5. 通用化用户可见措辞

把与实现位置无关的 “VPS” 提示改为“主机”或“服务端主机”，包括内存、磁盘、路径
脱敏和 Full access 说明。确实只讨论 Linux VPS 的公网部署段落可以保留准确措辞。

测试名称和断言也应同步更新，防止将来重新引入单平台假设。措辞调整不得削弱 Full
access、项目白名单不是沙箱等安全警告。

## CI 修改方案

将 `.github/workflows/ci.yml` 的测试任务改成操作系统矩阵：

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, macos-latest]

runs-on: ${{ matrix.os }}
```

两个平台执行完全相同的基础步骤：

1. `actions/checkout`；
2. `actions/setup-node`，Node.js 24；
3. `npm ci`；
4. `npm run typecheck`；
5. `npm test`。

CI 不应依赖真实 Codex 登录，也不运行会消耗账户权限的端到端任务。与真实 CLI 的
`app-server` smoke test 放在人工发布清单中。GitHub 托管的 macOS runner 架构也不能
替代所有实际硬件验证，因此发布前仍需要至少一次目标架构上的完整冒烟测试。

## 部署模板方案

### Linux

保留现有两项 systemd 服务：

- `ai-remote-upload.service`；
- `codex-remote.service`。

实现适配时更新 Linux 文档和模板交叉链接，但不借机改变已验证的启动顺序、非 root
账户、`UMask=0077`、回环监听和失败重启策略。

### macOS

新增两个系统级 LaunchDaemon 模板，例如：

```text
deploy/launchd/ai-remote-upload.plist.example
deploy/launchd/codex-remote.plist.example
```

LaunchDaemon 而不是 LaunchAgent，确保没有图形登录时也能启动。公开模板只能包含占位符，
至少包括：

- `__RUN_USER__` 与 `__RUN_GROUP__`；
- 两个服务各自的 `__SERVICE_LABEL__`；
- `__RUN_HOME__`；
- `__APP_DIR__`；
- `__NODE_BIN__` 与完整 `__RUNTIME_PATH__`；
- 两个服务各自的环境文件绝对路径；
- 可写且受保护的日志目录。

模板建议使用：

- `UserName`、`GroupName`：以已登录 Codex 且有项目权限的非 root 用户运行；
- `WorkingDirectory`：仓库目录；
- `EnvironmentVariables`：只放 `HOME`、`PATH`、`NODE_ENV` 等非秘密值；
- `ProgramArguments`：使用 Node.js 24 的 `--env-file=<absolute-path>` 读取仓库外或被忽略的
  `0600` 环境文件，再启动相应 TypeScript 入口；
- `RunAtLoad=true`；
- `KeepAlive` 只针对非正常退出；
- `ThrottleInterval`：避免启动失败时高速重启；
- `ProcessType=Background`；
- 明确的标准输出和错误日志路径，并在运维文档中给出轮转策略。

plist 中不得直接写访问令牌，也不得假定 Homebrew、Node、Codex、仓库或用户主目录位于
固定路径。安装前必须通过 `command -v`、`id` 和文件检查获得实际值。

两个 LaunchDaemon 都在开机时启动，不要求用脆弱的启动顺序模拟 systemd 依赖。上传
服务暂不可用时，纯文本 Remote 仍可启动，附件操作应明确失败；上传服务恢复后不应要求
重启整个网页服务。实现前应以现有客户端行为验证这一点。

macOS 部署文档至少给出以下操作及其验证点：

- 从 `.example` 生成未跟踪的本机配置；
- 检查所有占位符已经替换；
- 以管理员权限安装 root 持有的 plist 到 `/Library/LaunchDaemons/`；
- 使用 `launchctl bootstrap system`、`enable`、`kickstart` 和 `print` 管理服务；
- 使用 `launchctl bootout` 有序停止；
- 用 `curl` 验证回环 `/healthz`；
- 用 `lsof` 验证只监听回环地址；
- 检查日志、文件所有权、Codex 登录身份和残留子进程；
- 明确哪些命令需要管理员权限，哪些操作会中断浏览器会话。

## 文档调整方案

实现提交应同步完成：

- `README.md`：支持范围改为 Linux/macOS，链接两套部署文档；
- `docs/architecture.md`：将 Linux 专属内存描述改成平台资源适配层；
- `docs/operations.md`：保留跨平台的数据、更新、备份和中断语义，平台命令分别链接；
- `docs/deployment-linux.md`：承接当前 systemd 安装、日志和监听检查；
- `docs/deployment-macos.md`：说明 LaunchDaemon、plist 权限、日志、停止与回滚；
- `docs/deployment-ai.md`：只读检查和验收按系统选择 `systemctl` 或 `launchctl`，不能默认
  目标是 Linux；
- `docs/deployment-tailscale.md` 与 `docs/deployment-public.md`：分别给出 Linux/macOS 的
  监听检查命令，但继续要求唯一 HTTPS 入口和回环后端；
- 环境变量表：解释 macOS 的保守内存读数、0 门槛的风险和短 socket 路径要求。

## Codex CLI 与 App Server 版本策略

`src/generated/` 类型与生成它们的 Codex CLI 版本绑定。支持操作系统不等于支持所有 CLI
版本，因此实现过程中应：

1. 记录生成类型时使用的 CLI 版本；
2. 选定一个明确的最低测试版本或发布时验证版本；
3. 用该版本执行 `codex app-server generate-ts --out ./schemas`；
4. 审查生成差异，再更新 `src/generated/`，不能机械覆盖本地适配；
5. 在 Linux 和 macOS 分别运行 `codex app-server --stdio` 初始化 smoke test；
6. 人工验证项目使用的实验方法、审批、交互请求、`thread/rollback` 和
   `thread/settings/update`；
7. 升级 CLI 后重复类型检查、单元测试和浏览器验收。

如果当前版本在两个平台返回不同的平台标识或能力列表，应把差异记入兼容说明；不要
为了让测试通过而假定未返回的实验能力存在。

## 推荐实施顺序

### 阶段 A：最小代码适配

1. 提取并测试内存检测模块；
2. 接入 Worker 管理器；
3. 通用化用户可见的主机措辞；
4. 在 Linux 上运行类型检查和完整测试，确认没有回归。

### 阶段 B：双平台自动验证

1. 增加 GitHub Actions 操作系统矩阵；
2. 修复 macOS CI 暴露的真实兼容问题；
3. 重点确认进程组、Unix socket、SQLite 和 `statfs`；
4. 不为未经测试的推测加入平台分支。

### 阶段 C：部署资源与文档

1. 新增 LaunchDaemon 模板；
2. 拆分 Linux/macOS 部署命令；
3. 更新 README、架构、AI 部署规范和网络入口文档；
4. 检查模板中没有真实路径、账户、令牌或网络配置。

### 阶段 D：真实 macOS 验收

先在普通终端前台运行两个进程，完整验证后再安装 LaunchDaemon。至少检查：

- Node.js 与 Codex CLI 路径、版本及服务账户登录状态；
- 目录 App Server 初始化；
- 新建、恢复、重命名、归档和回收站；
- 普通消息、队列、停止、审批和交互请求；
- `/model`、`/permissions`、`/plan`、`/compact`、`/review`、`/rewind`、`/status` 和
  `/usage`；
- 图片与 UTF-8 文本附件，上传租约和过期清理；
- Worker 内存门槛在正常、低内存和关闭门槛三种配置下的行为；
- 页面断线重连、事件回放和任务继续运行；
- Worker 完成、取消及异常后的完整进程树清理；
- 回环监听、错误令牌拒绝、正确令牌登录和实际 HTTPS 入口；
- 无图形登录的开机启动、失败重启、日志和有序停止。

### 阶段 E：发布与观察

1. 先发布为“macOS 已验证”的版本或预发布说明；
2. 保留原 Linux 部署不变并完成 Linux 回归；
3. 观察多次任务、休眠/唤醒、网络切换和至少一次重启；
4. 验收通过后再把 macOS 从实验支持提升为正式支持。

## 验收标准

只有同时满足以下条件，才能宣布 macOS 适配完成：

- Ubuntu 和 macOS CI 的类型检查及完整测试通过；
- 真实 macOS 目标架构通过 App Server 与浏览器流程验收；
- 默认内存门槛不会永久阻止 Worker，也不会在无法读数时冒险启动；
- Worker 退出后没有遗留 App Server 或工具子进程；
- 共享附件 socket 和状态文件权限符合 `0700`/`0600` 设计；
- 两个 LaunchDaemon 能在无图形登录时启动，并以非 root 用户运行；
- 后端仍只监听 `127.0.0.1`，HTTPS 入口和应用令牌验证均成功；
- 错误日志不泄露令牌、凭证、会话正文或不必要的绝对路径；
- 更新、停止、日志、备份和回滚命令在文档中完整且经过实际验证；
- Linux 原有部署和测试没有回归。

## 升级、迁移与回滚原则

平台支持应先作为代码兼容和新部署能力交付，不自动复制另一台主机上的 Codex 登录、
原生会话或 Worker SQLite。源码可以通过 Git 获取；凭证应由各目标主机的最终服务账户
独立登录并由 Codex CLI 管理。

如果确实需要迁移会话或后台任务状态，应另写有停机窗口、SQLite WAL 处理、文件权限、
版本匹配和恢复验证的迁移方案。不能在服务运行时只复制主数据库文件，也不能把登录
目录当作普通项目文件同步。

回滚应限制在当前目标主机：停止并卸载新增的 LaunchDaemon，移除该主机自己的 HTTPS
入口，然后恢复到前台启动或先前版本。不要用全局进程名清理命令，也不要让一个平台的
回滚中断另一平台上独立运行的实例。

## 评审清单

实现前建议逐项回答：

- `os.freemem()` 作为 macOS 首版保守门槛是否会在常见内存压力下过度拦截？
- 内存读数失败时的一次性诊断应放在适配层还是 Worker 管理器？
- macOS CI 是否稳定覆盖 detached 进程组的后代清理语义？
- 默认 Unix socket 路径及所有文档示例是否足够短？
- LaunchDaemon 是否能只通过 plist 和 `--env-file` 启动，而不引入保存秘密的 wrapper？
- 日志目录由谁创建、谁拥有、如何轮转？
- 两项 LaunchDaemon 无强依赖启动顺序时，附件服务恢复行为是否符合预期？
- 应选择哪个 Codex CLI 版本重新生成并审查 App Server 类型？
- 现有 Linux 文档拆分是否会破坏已有链接，是否需要保留兼容入口？
- 真实 macOS 验收完成前，README 应标记为实验支持还是正式支持？
