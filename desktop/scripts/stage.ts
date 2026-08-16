#!/usr/bin/env bun
/**
 * 打包暂存脚本：把构建产物铺到 desktop/vendor/，供 electrobun build.copy 打包进应用资源。
 *
 * 产物布局（vendor/ 内部保持与源码一致的相对结构，后端依赖 import.meta.dir 定位资源）：
 *   vendor/server/dist/index.js    ← bun build --target=bun 的 server bundle
 *   vendor/server/prompts/         ← server/prompts（含 docs/、messages/）
 *   vendor/server/skills/          ← server/skills
 *   vendor/server/validation/      ← server/validation/validate_extension.py
 *   vendor/web/                    ← web/dist（vite build 输出）
 *   vendor/opencode/opencode[.exe] ← 由 scripts/fetch-opencode.ts 下载（本脚本只检查）
 *
 * 幂等：可重复执行；不会删除 vendor/opencode（避免重复下载）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const DESKTOP_DIR = dirname(import.meta.dir); // desktop/
const REPO_ROOT = dirname(DESKTOP_DIR); // Studio/
const SERVER_DIR = join(REPO_ROOT, "server");
const WEB_DIR = join(REPO_ROOT, "web");
const VENDOR = join(DESKTOP_DIR, "vendor");
const VENDOR_SERVER = join(VENDOR, "server");
const VENDOR_WEB = join(VENDOR, "web");

function run(command: string, args: string[], cwd: string) {
  console.log(`==> ${command} ${args.join(" ")}（cwd=${cwd}）`);
  const res = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`命令失败：${command} ${args.join(" ")}（exit=${res.status}）`);
  }
}

function copyDir(src: string, dest: string, label: string) {
  console.log(`==> 复制 ${label}: ${src} -> ${dest}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/** 目录内最新 mtime（用于判断 web 源码是否比 dist 新） */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    const m = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs;
    if (m > max) max = m;
  }
  return max;
}

mkdirSync(VENDOR, { recursive: true });

// ---- 1. 后端 bundle + 静态资产 ----
const serverEntry = join(SERVER_DIR, "src", "index.ts");
if (!existsSync(serverEntry)) throw new Error(`找不到后端入口：${serverEntry}`);
run("bun", ["install"], SERVER_DIR); // 确保依赖就绪（幂等）
const serverOutfile = join(VENDOR_SERVER, "dist", "index.js");
mkdirSync(dirname(serverOutfile), { recursive: true });
run(
  "bun",
  ["build", "src/index.ts", "--target=bun", "--outfile", serverOutfile, "--minify"],
  SERVER_DIR,
);
copyDir(join(SERVER_DIR, "prompts"), join(VENDOR_SERVER, "prompts"), "prompts");
copyDir(join(SERVER_DIR, "skills"), join(VENDOR_SERVER, "skills"), "skills");
copyDir(join(SERVER_DIR, "validation"), join(VENDOR_SERVER, "validation"), "validation");

// ---- 2. 前端构建产物 ----
const webDist = join(WEB_DIR, "dist");
const distIndex = join(webDist, "index.html");
// dist 缺失或源码比 dist 新时重建（避免打包到过期前端）
const srcNewest = Math.max(
  newestMtime(join(WEB_DIR, "src")),
  ...["index.html", "vite.config.js", "package.json"].map((f) => {
    try {
      return statSync(join(WEB_DIR, f)).mtimeMs;
    } catch {
      return 0;
    }
  }),
);
const needWebBuild =
  !existsSync(distIndex) || srcNewest > statSync(distIndex).mtimeMs;
if (needWebBuild) {
  console.log("==> web/dist 缺失或已过期，先执行前端构建…");
  run("bun", ["install"], WEB_DIR);
  run("bun", ["run", "build"], WEB_DIR);
} else {
  console.log("==> web/dist 已是最新，跳过前端构建");
}
copyDir(webDist, VENDOR_WEB, "web dist");

// ---- 3. 内置 opencode（仅检查） ----
const opencodeBin = join(
  VENDOR,
  "opencode",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
if (!existsSync(opencodeBin)) {
  console.warn(
    "⚠ 未找到内置 opencode，请先执行：bun scripts/fetch-opencode.ts（生产构建前必须执行）",
  );
} else {
  console.log("==> 内置 opencode 就绪：" + opencodeBin);
}

console.log("\n==> 暂存完成：" + VENDOR);
