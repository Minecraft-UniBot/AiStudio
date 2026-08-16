/**
 * hutch preBuild 钩子（运行在 host 平台 Cottontail 下）：
 * 委托给 scripts/stage.ts 确保 vendor/ 就绪后再打包。
 * 钩子继承进程环境；bun 需在 PATH 中（CI 与开发机均满足）。
 */
import { spawnSync } from "node:child_process";

const result = spawnSync("bun", ["scripts/stage.ts"], {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error(`preBuild 暂存失败（exit=${result.status}）`);
  process.exit(result.status ?? 1);
}
