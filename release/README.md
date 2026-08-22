# 单文件可执行版（release/）

把「后端 + 前端 + 内置资源」打包为**一个自包含可执行文件**，运行即自动初始化并启动服务器，
无需安装 bun / opencode / 前端依赖。opencode 不内置（减小安装包体积）：
首次启动时由后端自动下载到数据目录（`~/.unibot-studio/opencode-bin/`，带版本标记复用）。

## 构建

```bash
# 要求 Bun >= 1.4.0（--asset 目录嵌入支持）
bun release/build.ts [--outdir release/artifacts] [--name unibot-studio] [--force-web]
```

流程（build.ts 自动完成）：

1. 安装 server / web 依赖（幂等；`--frozen` 用 `--frozen-lockfile`）
2. 构建前端（`web/dist` 比源码新则跳过；`--force-web` 强制）
3. 预打包测试工具插件（`server/plugins/unibot-tools.ts` → 自包含 JS，见 server/src/opencode.ts）
4. 写入版本号（`STUDIO_APP_VERSION` 环境变量 > git 最近 tag > `0.1.0`）
5. `bun build --compile --asset=...` 编译单文件可执行版（产物在 `release/artifacts/`）

## 运行

```bash
./release/artifacts/unibot-studio        # 双击 / 直接运行
unibot-studio --version                  # 查看版本
unibot-studio --help                     # 查看用法与环境变量
```

首次运行会把内置资源解压到数据目录 `<数据目录>/resources`（默认 `~/.unibot-studio/resources`，
带版本标记，升级后自动重新解压），并自动下载 opencode（约 45MB，仅此一次）到
`<数据目录>/opencode-bin/`；默认端口 9876 被占用时自动换空闲端口；
启动后打印访问地址与访问口令，并自动打开浏览器（`UNIBOT_STUDIO_NO_BROWSER=1` 关闭）。
日志同时落盘 `<数据目录>/logs/studio.log`。

## 目录结构

```text
release/
├── src/main.ts               # 可执行入口：解压内置资源 → 设置 env → 动态加载后端 → 打开浏览器
├── src/version.generated.ts  # 版本号（build.ts 自动写入，默认值随仓库提交）
├── build.ts                  # 一键打包脚本
├── vendor/                   # 打包暂存：预打包插件产物（gitignored）
└── artifacts/                # 打包产物（gitignored）
```

## 发布

推送 tag `v*`（如 `v0.2.0`）或手动触发 `.github/workflows/release.yml`：
在原生 runner 上分别为 macOS ARM64 / macOS x64 / Windows x64 / Linux x64 构建
`unibot-studio-<平台>[.exe]`，tag 推送会自动创建 Release 草稿并附上全部产物。
