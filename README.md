# UniBot Extension Studio

基于 OpenCode Server 的 UniBot 扩展开发平台：让不会写代码的用户用自然语言创建、检查并发布 UniBot 原生扩展。

> 实现状态：对应 `Studio/AGENT.md` 的第一版核心闭环（创建 → 生成（AI 用测试工具自测）→ 机械校验 → 一键发布）。

## 功能

- **创建草稿**：从空白脚手架创建 `api` / `command` 类型扩展，一句话描述需求
- **AI 协作开发**：OpenCode 在隔离草稿工作区中生成代码，实时展示消息、推理与工具调用
- **后台自动校验**：路径检查、`Extension.toml` 严格校验、Python 语法与 import 边界、Ruff、pytest、Loader 绑定、依赖声明
- **AI 自测（OpenCode 插件测试工具）**：编码时 AI 用 `unibot_*` 工具把扩展部署到共享测试环境并加载、运行测试，当场修复
- **一键发布**：核对文件摘要后原子交付到 `UniBot/Extensions/<id>/`，已存在则拒绝覆盖
- **可恢复**：草稿元数据、会话、消息、校验结果落盘，刷新页面不丢失进度

## 目录结构

```text
Studio/
├── server/                      # 后端：Bun + TypeScript
│   ├── src/
│   │   ├── index.ts             # REST / WebSocket 路由与平台认证
│   │   ├── opencode.ts          # OpenCode 网关（子进程 + SDK + 插件/超时注入）
│   │   ├── drafts.ts            # 草稿 CRUD、脚手架、路径安全、文件摘要
│   │   ├── validation.ts        # 校验流水线编排
│   │   ├── test_tools.ts        # 测试工具后端：部署/加载/测试/日志
│   │   ├── publishing.ts        # 原子发布器
│   │   ├── events.ts            # SSE 事件归一化与 WebSocket 广播
│   │   └── config.ts            # 平台配置
│   ├── validation/              # UniBot 校验脚本（只读复用 UniBot 工具链）
│   │   └── validate_extension.py
│   └── prompts/                 # 提示词模板
├── web/                         # 前端：Vue 3 + Vite（独立应用）
│   └── src/
│       ├── views/               # Login / Drafts / Workspace / Admin
│       ├── components/studio/   # MessagePart / PermissionRequest
│       ├── stores/studio.js     # Pinia store
│       └── utils/               # api 封装、状态映射
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

## 桌面客户端（Electrobun）

`desktop/` 提供跨平台**原生窗口**桌面应用（macOS ARM64 / Windows x64 / Linux x64）：
内置 opencode（无需用户单独安装），「后端 + 前端」一体，双击即打开工坊窗口。

```bash
cd desktop
bun scripts/fetch-opencode.ts     # 下载内置 opencode（npm registry，约 45MB）
bun run build:production          # 构建当前平台（产物在 desktop/artifacts/）
```

- 开发、配置与常见问题：见 [`desktop/README.md`](desktop/README.md)
- 打包工作流：`.github/workflows/build-desktop.yml`（手动触发，或推送 tag `desktop-v*` 自动构建并创建 Release 草稿）
- **交付物**：只发布三平台自包含的 **app 归档**（`*.tar.zst`，解压即点开即用，原生窗口），
  不发布安装包（`.dmg` / `*-Setup.zip` / `*-Setup.tar.gz`）；Electrobun 无 macOS x64 核心，
  Intel Mac 用 Web 版（`cd web && bun run dev`）

## 配置

配置存于 `~/.unibot-studio/config/studio.json`（数据目录 `~/.unibot-studio/`）：

| 环境变量 | 说明 |
| --- | --- |
| `UNIBOT_STUDIO_PORT` | 后端端口（默认 9876） |
| `UNIBOT_STUDIO_HOST` | 监听地址（默认 127.0.0.1） |
| `UNIBOT_STUDIO_DATA_DIR` | 平台数据目录（默认 `~/.unibot-studio`） |
| `UNIBOT_DIR` | UniBot 根目录（默认自动探测） |
| `UNIBOT_STUDIO_PASSWORD` | 平台访问口令（覆盖自动生成） |
| `OPENCODE_BIN` | opencode 可执行文件路径 |

## 安全模型

- 后端是唯一可信边界：浏览器不直连 OpenCode，不接触其密码
- OpenCode 仅监听 `127.0.0.1`，随机空闲端口，高熵口令仅存进程内存，独立 XDG 数据目录
- 草稿与运行目录隔离：AI 只能操作草稿工作区，发布是唯一交付通道
- 发布前核对文件 SHA-256 摘要与校验结果；staging 临时目录 + 原子重命名
- 校验子进程不继承机器人 Token，命令白名单 + 超时 + 输出上限
- 权限默认拒绝：bash 默认询问，`always` 在后端降级为 `once`

## 文档

- 方案设计：`Studio/Plan.md`
- 扩展系统设计：`Studio/PluginDocs.md`
- 前端编码规范：`Studio/Fronted.md`
