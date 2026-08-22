# UniBot Extension Studio

基于 OpenCode Server 的 UniBot 扩展开发平台：让不会写代码的用户用自然语言创建、检查并发布 UniBot 原生扩展。

> 实现状态：对应 `Studio/AGENT.md` 的第一版核心闭环（创建 → 生成（AI 用测试工具自测）→ 机械校验 → 一键发布）。

## 功能

- **创建草稿**：从内置最小脚手架或 Default 扩展模板创建，一句话描述需求；可选目标 MC 服务器（扫描类型/版本/插件模组注入提示词）
- **两阶段生成**：AI 先输出规划（PLAN.md），再进入编码；编码阶段用 `unibot_*` 测试工具把扩展部署到共享测试环境加载、运行测试、当场修复
- **后台自动校验**：路径检查、`Extension.toml` 严格校验、Python 语法与 import 边界、Ruff、pytest、Loader 绑定、依赖声明
- **一键发布**：核对文件 SHA-256 摘要后原子交付到 `UniBot/Extensions/<id>/`，已存在则拒绝覆盖
- **可恢复**：草稿元数据、会话、消息、校验结果落盘，刷新页面不丢失进度

## 目录结构

```text
Studio/
├── server/                        # 后端：Bun + TypeScript
│   ├── src/
│   │   ├── index.ts               # REST / WebSocket 路由与平台认证
│   │   ├── paths.ts               # src 根锚点（资源定位基准）
│   │   ├── core/                  # config / auth / logger / disk / types
│   │   ├── opencode/              # gateway（子进程+SDK）/ download / events（SSE 归一化）
│   │   ├── studio/                # drafts / sessions / validation / publishing /
│   │   │                          # test_tools / templates / preview / mc_server / unibot_env
│   │   └── ai/                    # pipeline / prompts / skills / tools / registry
│   ├── validation/                # UniBot 校验脚本（只读复用 UniBot 工具链）
│   ├── prompts/                   # 提示词模板 + 本地文档白名单副本
│   ├── skills/                    # 按扩展类型加载的开发技能
│   ├── plugins/                   # OpenCode 插件：unibot_* 测试工具
│   └── tests/                     # bun test 单元测试
├── web/                           # 前端：Vue 3 + Vite（独立应用）
│   └── src/
│       ├── views/                 # Login / Drafts / Workspace / Admin
│       ├── components/studio/     # ConversationPanel / MessagePart / TemplatePreview …
│       ├── stores/studio.js       # Pinia store
│       └── utils/                 # api 封装、状态映射
├── release/                       # 单文件可执行版打包（见下方「单文件可执行版」）
│   ├── src/main.ts                # 可执行入口：解压内置资源 → 启动服务器 → 打印登录地址
│   └── build.ts                   # 一键打包脚本（bun build --compile --asset）
└── Install.sh
```

## 快速开始

前置要求：`bun`、`opencode`（>= 1.18，`opencode serve` 需要），本机装有 UniBot（用于复用其 Python 工具链）。

```bash
./Install.sh

# 终端 1：后端
cd server && bun src/index.ts

# 终端 2：前端（开发模式）
cd web && bun run dev
```

浏览器访问 `http://localhost:9877`，使用平台访问口令登录（首次启动自动生成，保存在 `~/.unibot-studio/config/studio.json`，可用 `UNIBOT_STUDIO_PASSWORD` 环境变量覆盖）。

## 单文件可执行版

`release/` 把「后端 + 前端 + 内置资源」打包成**一个自包含可执行文件**：
运行即自动初始化并启动服务器（REST / WebSocket / 前端页面同源），并在终端打印
携带登录 token 的访问地址（直接复制到浏览器即可进入平台），无需任何其他操作。
opencode 不内置（减小安装包体积）：**首次启动时自动下载**
到数据目录（`~/.unibot-studio/opencode-bin/`，约 45MB，带版本标记复用），用户无需安装。

```bash
bun release/build.ts            # 一键打包（要求 Bun >= 1.4；产物在 release/artifacts/）
```

- 打包内容：server bundle + `web/dist` + `prompts/skills/validation/plugins`（opencode 首次启动自动下载）
- 运行行为：首次运行解压内置资源（`~/.unibot-studio/resources`，带版本标记自动更新）并下载 opencode，
  默认端口 9876 被占用时自动换空闲端口，启动后打印访问地址（拼接登录 token，直接打开即可进入平台）与口令
- 命令行：`--version` / `--help` / `--data <目录>`（指定数据目录）/ `--unibot <目录>`（指定 UniBot 根目录，
  均优先于同名环境变量）；环境变量同下方「配置」表
- 发布工作流：`.github/workflows/release.yml`（手动触发，或推送 tag `v*` 自动构建并创建 Release 草稿），
  产物为各平台自包含可执行文件：`unibot-studio-{macos-arm64,macos-x64,windows-x64,linux-x64}[.exe]`
  （macOS x64 由 macOS ARM64 runner 交叉编译，best-effort，失败不影响发布）

开发模式仍走源码运行：`cd server && bun src/index.ts` + `cd web && bun run dev`。

## 配置

配置存于 `~/.unibot-studio/config/studio.json`（数据目录 `~/.unibot-studio/`）：

| 环境变量 | 说明 |
| --- | --- |
| `UNIBOT_STUDIO_PORT` | 后端端口（默认 9876） |
| `UNIBOT_STUDIO_HOST` | 监听地址（默认 127.0.0.1） |
| `UNIBOT_STUDIO_DATA_DIR` | 平台数据目录（默认 `~/.unibot-studio`） |
| `UNIBOT_DIR` | UniBot 根目录（默认自动探测） |
| `UNIBOT_STUDIO_PASSWORD` | 平台访问口令（覆盖自动生成） |
| `UNIBOT_STUDIO_LOG_LEVEL` | 日志级别：`debug` / `info` / `warn` / `error`（默认 `info`） |
| `UNIBOT_STUDIO_LOG_FILE` | 日志文件路径（默认 `<数据目录>/logs/studio.log`；设 `off` 关闭落盘） |
| `OPENCODE_BIN` | opencode 可执行文件路径 |

日志同时输出到控制台（终端自动配色，`NO_COLOR` 可关闭，`UNIBOT_STUDIO_LOG_COLOR=1/0` 显式开关优先）
与 `<数据目录>/logs/studio.log`（单行纯文本，无 ANSI，超 20MB 自动轮转为 `.log.1`）。

## 安全模型

- 后端是唯一可信边界：浏览器不直连 OpenCode，不接触其密码
- OpenCode 仅监听 `127.0.0.1`，随机空闲端口，高熵口令仅存进程内存，独立 XDG 数据目录
- 草稿与运行目录隔离：AI 只能操作草稿工作区，发布是唯一交付通道
- 发布前核对文件 SHA-256 摘要与校验结果；staging 临时目录 + 原子重命名
- 校验子进程不继承机器人 Token，命令白名单 + 超时 + 输出上限
- 权限默认拒绝：bash 默认询问，`always` 在后端降级为 `once`

## 文档

- 架构与实现现状、编码规范：`Studio/AGENT.md`
- 扩展系统设计：`Studio/PluginDocs.md`
