// @hutch cli=production cottontail=production
/**
 * Hutch 项目配置（Electrobun 2.x）：
 * - electrobun.version 是精确的 Electrobun 核心版本 pin，升级需显式修改
 * - packageManager 选择 bun：`hutch install` / `hutch pm ...` 委托给 bun
 * - scripts 只从本文件读取；应用构建与打包描述见 electrobun.config.ts
 */
export default {
  electrobun: {
    version: "2.0.1-beta.14",
  },
  packageManager: "bun",
  scripts: {
    install: ["hutch", "pm", "install", "--frozen-lockfile"],
    dev: ["hutch", "electrobun", "dev", "--watch"],
    "build:canary": ["hutch", "electrobun", "build", "--env=canary"],
    "build:production": ["hutch", "electrobun", "build", "--env=production"],
  },
};
