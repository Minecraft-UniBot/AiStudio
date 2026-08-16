import type { ElectrobunConfig } from "electrobun";

/**
 * 桌面客户端构建配置。
 *
 * 打包内容（由 scripts/stage.ts 预先铺到 vendor/，再通过 build.copy 进入应用资源目录）：
 * - vendor/web      → Resources/web       前端构建产物（web/dist，vite build 输出）
 * - vendor/server   → Resources/server     后端 bundle（server/dist/index.js）+ prompts/skills/validation
 * - vendor/opencode → Resources/opencode   内置 opencode 可执行文件（scripts/fetch-opencode.ts 下载）
 *
 * 主进程（src/bun/index.ts）运行时通过 PATHS.RESOURCES_FOLDER 定位以上资源，
 * 以 child process 启动后端（Bun.serve + 静态服务），窗口加载 http://127.0.0.1:<port>/。
 */
export default {
  app: {
    name: "UniBot Extension Studio",
    identifier: "com.unibot.extension-studio",
    version: process.env.STUDIO_APP_VERSION ?? "0.1.0",
    description: "基于 OpenCode 的 UniBot 扩展开发平台",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
      minify: true,
    },
    copy: {
      "vendor/web": "web",
      "vendor/server": "server",
      "vendor/opencode": "opencode",
    },
  },
  scripts: {
    // 构建前确保 vendor/ 就绪（幂等；CI 中 workflow 也会先显式执行 stage）
    preBuild: "./scripts/pre-build.ts",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  release: {
    // 配置 STUDIO_RELEASE_BASE_URL 后启用二进制差分更新；未配置时不访问发布源
    baseUrl: process.env.STUDIO_RELEASE_BASE_URL ?? "",
    generatePatch: Boolean(process.env.STUDIO_RELEASE_BASE_URL),
  },
} satisfies ElectrobunConfig;
