# AGENTS.md

## 运行方式

Node 直接运行 TypeScript 源码,**没有构建步骤**。改完代码不需要 build。

```bash
npm start          # node src/server/main.ts
npm run typecheck
npm test
```

## 部署

本项目在作者的私有主机上以 systemd 服务长期运行,只通过 Tailscale 暴露给私有网络,没有公网入口。

⚠️ **不要照仓库里的文件推断线上部署配置。**
- `deploy/*.service.example` 是样例,不是线上配置。
- `deploy/*.service.local` 是本地文件,不进 git,可能与线上不一致。
- 线上实际生效的配置只有 `systemctl cat <unit>` 能看到。服务可能被 drop-in 覆盖 `ExecStart`,也可能经一个包装脚本启动,而**包装脚本不在本仓库内**。

⚠️ **如果你正在部署主机上工作,先读 `docs/deployment.node1.local.md`。** 那份文件不进 git,记录了本机的单元名、端口、重启命令、`ExecStart` 的实际位置和已知的坑。没读它就猜服务怎么重启,多半会猜错。

## 跨平台：Linux 与 macOS 都要能跑

本项目同时部署在 Linux（systemd）和 macOS（launchd）上，仓库里两套部署样例都在。**改代码时必须保证两边通用**——不要造成「从远端拉一次更新，原来的 macOS 部署就起不来了」。

常见的坑：

- **进程管理器不通用。** Linux 是 systemd，macOS 是 launchd。不要在应用代码里假设 `systemctl` 存在，也不要依赖 systemd 专有的运行环境（`NOTIFY_SOCKET`、`JOURNAL_STREAM` 等）。
- **不要读 `/proc`。** macOS 没有这个文件系统。取可用内存、进程信息要分平台实现（Linux 读 `/proc/meminfo` 的 `MemAvailable`，macOS 用 `vm_stat`），并且在专用读数失败时给出安全的兜底，而不是直接崩。
- **路径不要硬编码 Linux 布局。** 用 `os.homedir()`，保留 `XDG_DATA_HOME` 这类环境变量覆盖；不要假定 `/home/<user>` 或 `/var/lib` 存在。
- **外部命令的行为有差异。** macOS 自带的是 BSD 版本，`sed -i`、`stat`、`readlink -f`、`date` 的参数与 GNU 不兼容。能用 Node 完成的就不要调外部命令。
- **文件系统默认不区分大小写。** macOS 上 `Foo.ts` 和 `foo.ts` 是同一个文件，Linux 上不是。import 路径的大小写必须与真实文件名完全一致，否则只会在 Linux 上炸。

改动涉及进程管理、路径解析、系统资源探测或外部命令时，先确认两个平台都走得通再合并。
