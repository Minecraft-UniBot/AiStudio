# UniBot Extension Studio 桌面客户端（Electrobun）

把 `server/` + `web/` 封装为跨平台桌面应用：安装包**自带 opencode**（无需用户单独安装），
安装后启动即为「Studio 后端 + 前端」一体，主窗口直接打开工坊。

- 运行时：Electrobun（Bun 主进程 + 系统 WebView），构建工具 [Hutch](https://hutch.blackboard.sh)
- 打包内容：后端 bundle（`server/dist/index.js` + prompts/skills/validation）、前端构建产物（`web/dist`）、内置 opencode 二进制
- 数据目录：`Utils.paths.userData`（`<系统AppData>/com.unibot.extension-studio/<channel>`），后端数据、草稿、日志、opencode 隔离数据都在其中

## 单文件可运行版（无安装包）

不需要 hutch / Electrobun、不需要安装包：`bun build --compile` 把「后端 + 前端」打成**单个可执行文件**，
双击/终端运行即自动打开浏览器进入工坊（UI 与桌面版/Web 版同一套 Vue 前端，REST/WebSocket 走 127.0.0.1）。

适合：不想装东西直接跑、把 exe 拷到任意机器分发（CI / Release 发布 **macOS ARM64** 版；
本机 `bun run build:portable` 也可在当前架构上自行构建，Intel Mac 本地构建后同样可跑）。

```bash
cd desktop
bun run build:portable   # = stage（复用）→ 生成嵌入清单 → 编译
# 产物：desktop/artifacts/portable/UniBotStudio-<平台>-<架构>（约 66MB）
```

运行（产物自带全部资源，唯一依赖是首次联网下载 opencode 引擎，约 45MB）：

- **opencode 定位顺序**：`OPENCODE_BIN` 环境变量 → exe 同目录的 `opencode` → 上次下载到数据目录的副本
- 都没有时，**首次运行自动从 npm registry 下载**（`OPENCODE_VERSION` 可指定版本，默认 1.18.18）；
  下载失败会提示重试方式，工坊仍能打开（AI 功能不可用）
- 数据目录：默认 `~/.unibot-studio`（可用 `UNIBOT_STUDIO_DATA_DIR` 覆盖）；内置资源解压到
  `<数据目录>/portable/resources/`（版本戳变化即 exe 升级时自动重新解压）
- 退出：Ctrl-C / Cmd-C（自动回收 opencode 子进程）；`UNIBOT_STUDIO_DEBUG=1` 可看详细启动日志

实现要点（`desktop/portable/launcher.ts` + `desktop/scripts/build-portable.ts`）：

- 资源嵌入用 `import x from "…" with { type: "file" }`（Bun 编译期嵌入，运行期按需解压）；
  **server bundle 不做编译期内联**——顶层 `await startEventConsumer()` 永不返回，若内联会导致
  启动器后续代码被阻塞，因此与桌面版一致，先 stage 出 `server/dist/index.js`，运行时以文件 import 加载
- 后端资源目录通过 `UNIBOT_STUDIO_RES_DIR` 重定位（`server/src/config.ts` 的 `resSrcDir()`），
  启动器解压出的 `resources/` 结构与 `server/` 保持一致的相对布局
- 内置清单由构建脚本自动生成（`portable/generated-assets.ts`，gitignored），
  任何资源文件变化都会改变版本戳，触发用户侧自动重新解压

> 跨平台：`bun build --compile` 支持 `--target` 交叉编译（`bun scripts/build-portable.ts --target=bun-darwin-x64`
> 等，Bun 自动下载目标运行时）；当前 CI 只发布 **macOS ARM64** 单文件版（Intel Mac 用 Web 版）。
> opencode 下载逻辑已按平台选择对应 npm 包。

## 目录结构

```text
desktop/
├── hutch.config.ts          # 项目任务与 Electrobun 版本 pin（勿随意升级）
├── electrobun.config.ts     # 应用标识、主进程、copy 打包清单、preBuild 钩子
├── src/bun/index.ts         # 主进程：起后端子进程、开窗口、退出清理
├── portable/
│   └── launcher.ts          # 单文件可运行版启动器（bun build --compile 入口）
├── scripts/
│   ├── stage.ts             # 暂存：bundle 后端、同步前端产物、检查 opencode（幂等）
│   ├── fetch-opencode.ts    # 下载内置 opencode（默认 npm registry）
│   ├── build-portable.ts    # 构建单文件可运行版（生成嵌入清单 + 编译）
│   └── pre-build.ts         # hutch preBuild 钩子，委托 stage.ts
├── vendor/                  # 暂存产物（gitignored，打包输入）
│   ├── server/  web/  opencode/
└── artifacts/               # hutch 构建产物（安装包 + 更新归档）；portable/ 为单文件版产物
```

## 前置要求（构建机）

- macOS（arm64）/ Windows 11+ / Ubuntu 24.04+（Electrobun 官方支持矩阵；当前不发布 macOS x64 核心）
- [Bun](https://bun.sh) >= 1.2
- [Hutch](https://hutch.blackboard.sh)：`curl -fsSL https://hutch.blackboard.sh/hutch/install.sh | sh`（Windows 用 install.ps1）
- 仓库内 `server/`、`web/` 依赖由 `bun install` 安装

## 开发

```bash
cd desktop
hutch run install          # 安装本目录依赖（bun install --frozen-lockfile）
bun scripts/fetch-opencode.ts   # 下载内置 opencode（首次）
bun scripts/stage.ts            # 暂存打包输入（bundle 后端 + 同步前端 + 检查 opencode）
hutch electrobun dev --watch    # 构建并启动桌面应用（改动 src/bun 自动重build）
```

前端 UI 迭代仍走原流程（`cd web && bun run dev`，浏览器访问 9877）；
`stage.ts` 会在前端源码比 `web/dist` 新时自动重建，再 `hutch electrobun dev` 即可看到。

## 构建安装包

```bash
cd desktop
bun run build:production   # = stage + hutch electrobun build --env=production
bun run build:canary       # 预发布渠道（可与 production 并存）
```

产物在 `desktop/artifacts/`：

| 平台 | 产物 |
| --- | --- |
| macOS ARM64 | `production-macos-arm64-UniBotExtensionStudio.dmg` |
| Windows x64 | `production-win-x64-UniBotExtensionStudio-Setup.zip` |
| Linux x64 | `production-linux-x64-UniBotExtensionStudio-Setup.tar.gz` |

hutch 只构建当前宿主平台：完整矩阵需在 macOS / Windows / Linux 各自的原生环境构建
（仓库已提供 GitHub Actions 工作流，见下）。Electrobun 当前不发布 macOS x64 核心，
Intel Mac 暂无官方桌面构建，请使用 web 版本（`cd web && bun run dev`）。

## 内置 opencode

安装包内自带 opencode 可执行文件，应用启动后自动使用（`OPENCODE_BIN` 指向
`Resources/opencode/opencode`），无需用户安装。版本与后端固定版本一致（默认 1.18.18）：

```bash
bun scripts/fetch-opencode.ts                # 当前平台，npm registry（默认）
bun scripts/fetch-opencode.ts --version 1.19.0
bun scripts/fetch-opencode.ts --source=github  # 备选：GitHub Releases
```

> 升级 opencode 版本时，同步更新 `server/src/config.ts` 的 `opencode.version`
> 与工作流中的 `OPENCODE_VERSION`。

## 运行期说明

### 系统依赖（桌面端同样需要）

- `git`：草稿工作区初始化与 OpenCode 快照/回退
- `uv`：UniBot 测试环境依赖同步与扩展校验（`unibot-env` 会自动拉取 UniBot 源码）
- Linux：系统 WebKitGTK 4.1 / GTK3 运行库（WebView 需要）

### 模型 Provider 认证

后端以隔离的 XDG 目录启动 opencode（数据目录 `…/studio-data/opencode/`），
与个人 opencode 配置互不干扰。首次使用需在终端为**该隔离环境**登录模型：

```bash
# 在 Studio 设置页查看「数据目录」（<DATA_DIR>），然后：
XDG_CONFIG_HOME="<DATA_DIR>/opencode/config" opencode auth login   # macOS/Linux
# Windows（PowerShell）：
#   $env:XDG_CONFIG_HOME="<DATA_DIR>\opencode\config"; opencode auth login
```

登录后刷新页面，「模型」下拉即可选择已连接的 provider。

### 数据与日志

- 草稿、会话、配置、opencode 数据：`<userData>/studio-data/`
- 后端日志：`<userData>/studio-server.log`（主进程同时打印到 stdout）

## 打包工作流（GitHub Actions）

`.github/workflows/build-desktop.yml`：

- **手动触发**：构建并上传 artifacts；**推送 tag `desktop-v*`**（如 `desktop-v0.2.0`）时同时创建
  GitHub Release 草稿，版本号取自 tag（`desktop-v0.2.0` → `0.2.0`）
- **`build` job**（Electrobun 原生窗口安装包）：矩阵 `macos-14`(arm64) / `windows-latest`(x64) /
  `ubuntu-24.04`(x64)，Linux ARM64 在注释中预留；步骤：装 Bun → 装 Hutch（缓存 `~/.hutch`）→
  安装依赖 → 后端测试 → 构建前端 → 下载 opencode → stage → `hutch electrobun build --env=production` → 上传
- **`portable` job**（单文件可运行版，macOS ARM64）：`macos-14` 上 装 Bun → 安装依赖 → 构建前端 →
  stage → `bun scripts/build-portable.ts` → 上传（产物 `UniBotStudio-darwin-arm64`）
- **`release` job**：合并 `build` + `portable` 的全部产物到 Release 草稿

> macOS 正式分发如需通过 Gatekeeper，需在 `electrobun.config.ts` 开启
> `build.mac.codesign` / `notarize` 并配置签名凭据（见 [Code Signing](https://framework.blackboard.sh/electrobun/guides/code-signing/)）；
> 未签名的构建在本地双击打开时需右键 → 打开。

## 常见问题

- **窗口空白/后端未启动**：查看 `<userData>/studio-server.log`；确认 `server/dist/index.js`
  与前端产物已 stage（`bun scripts/stage.ts`）
- **OpenCode 版本不兼容**：内置版本与后端固定版本不一致（升级时需同步两处）
- **模型列表为空**：未完成上述 Provider 认证
- **发布/校验提示找不到 UniBot**：桌面端通过「设置」配置 UniBot 目录（`UNIBOT_DIR`）
