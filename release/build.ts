#!/usr/bin/env bun
/**
 * 一键打包脚本：构建 UniBot Extension Studio 单文件可执行版。
 *
 * 产物：一个自包含二进制（含后端、前端、prompts/skills/validation/plugins），
 * 运行即启动服务器，无需安装任何依赖（详见 release/README.md）。
 * opencode 不内置：首次启动时由后端自动下载到数据目录（减小安装包体积，
 * 见 server/src/opencode_download.ts）。
 *
 * 用法：
 *   bun release/build.ts [选项]
 *     --outdir <dir>        产物输出目录（默认 release/artifacts）
 *     --name <name>         产物文件名（默认 unibot-studio，Windows 自动加 .exe）
 *     --target <bun-target> bun build --compile 的目标平台（默认当前宿主；可交叉编译，
 *                           如 --target bun-darwin-x64 / bun-windows-x64 / bun-linux-x64）
 *     --force-web           总是重新构建前端（默认 dist 比源码新则跳过）
 *     --frozen              安装依赖时使用 --frozen-lockfile（CI 用）
 *
 * 版本号来源（优先级）：STUDIO_APP_VERSION 环境变量 > git 最近 tag > 0.1.0。
 * 要求：Bun >= 1.4.0（--asset 目录嵌入支持）。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---- 路径 ----
const RELEASE_DIR = import.meta.dir; // release/
const REPO_ROOT = dirname(RELEASE_DIR); // Studio/
const SERVER_DIR = join(REPO_ROOT, "server");
const WEB_DIR = join(REPO_ROOT, "web");

// ---- 参数解析 ----
const args = process.argv.slice(2);
function flag(name: string): boolean {
  return args.includes(name);
}
function flagValue(name: string): string | undefined {
  // 支持 --name=xxx 与 --name xxx 两种形式（CI 用空格分隔）
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return undefined;
}
const OUTDIR = resolve(flagValue("--outdir") ?? join(RELEASE_DIR, "artifacts"));
let NAME = flagValue("--name") ?? "unibot-studio";
const COMPILE_TARGET = flagValue("--target");
const FORCE_WEB = flag("--force-web");
const FROZEN = flag("--frozen");

// ---- 工具 ----
/**
 * 当前 Bun 可执行文件路径：脚本由 `bun release/build.ts` 运行，
 * 子命令必须交给同一个 Bun（版本 >= 1.4，否则 --asset 不可用）。
 * Bun.executablePath 在不同版本可能是字符串属性或函数，统一兜底到 process.execPath。
 */
function bunExecutable(): string {
  const p = (Bun as unknown as { executablePath?: unknown }).executablePath;
  if (typeof p === "string" && p) return p;
  if (typeof p === "function") {
    try {
      const r = (p as () => unknown)();
      if (typeof r === "string" && r) return r;
    } catch {
      // 忽略，继续兜底
    }
  }
  return process.execPath || "bun";
}

function run(command: string, cmdArgs: string[], cwd: string, opts: { check?: boolean } = {}): SpawnSyncReturns<Buffer> {
  const res = spawnSync(command, cmdArgs, { cwd, stdio: "inherit" });
  if (opts.check !== false && res.status !== 0) {
    const detail = res.signal ? `（signal=${res.signal}）` : res.error?.message ? `（${res.error.message}）` : "";
    throw new Error(`命令失败：${command} ${cmdArgs.join(" ")}（exit=${res.status}）${detail}`);
  }
  return res;
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

/** 解析构建版本号（仅接受 v 前缀的语义化版本 tag，避免旧 desktop-v* 等 tag 混入） */
function resolveVersion(): string {
  const fromEnv = process.env.STUDIO_APP_VERSION;
  if (fromEnv) return fromEnv.replace(/^v/, "");
  const git = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: REPO_ROOT, encoding: "utf-8" });
  if (git.status === 0) {
    const tag = git.stdout.trim().replace(/^v/, "");
    if (/^\d+\.\d+\.\d+/.test(tag)) return tag;
  }
  return "0.1.0";
}

// ---- 版本检查：--asset 目录嵌入需要 Bun >= 1.4 ----
const [bunMajor, bunMinor] = Bun.version.split(".").map(Number);
if (bunMajor < 1 || (bunMajor === 1 && bunMinor < 4)) {
  console.error(`需要 Bun >= 1.4.0（当前 ${Bun.version}），请先升级：bun upgrade`);
  process.exit(1);
}

console.log(`==> UniBot Extension Studio 单文件打包（Bun ${Bun.version}，版本 ${resolveVersion()}）`);

// ---- 1. 安装依赖（幂等） ----
const installFlag = FROZEN ? ["--frozen-lockfile"] : [];
run(bunExecutable(), ["install", ...installFlag], SERVER_DIR);
run(bunExecutable(), ["install", ...installFlag], WEB_DIR);

// ---- 2. 构建前端（web/dist 比源码新则跳过） ----
const webDist = join(WEB_DIR, "dist");
const distIndex = join(webDist, "index.html");
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
if (FORCE_WEB || !existsSync(distIndex) || srcNewest > statSync(distIndex).mtimeMs) {
  console.log("==> 构建前端（vite build）…");
  run(bunExecutable(), ["run", "build"], WEB_DIR);
} else {
  console.log("==> web/dist 已是最新，跳过前端构建");
}

// ---- 3. 预打包测试工具插件 ----
// 单文件版运行时没有 node_modules：server 在 opencode 启动前的 Bun.build
// 无法解析 @opencode-ai/plugin / zod（见 server/src/opencode.ts syncPlugins 的
// "预打包" 分支），因此打包期就把它打成自包含 JS，随 exe 嵌入。
const pluginOut = join(RELEASE_DIR, "vendor", "plugin", "unibot-tools.js");
console.log("==> 预打包测试工具插件（unibot-tools.js）…");
run(
  bunExecutable(),
  ["build", "server/plugins/unibot-tools.ts", "--outfile", pluginOut, "--target=bun", "--format=esm"],
  REPO_ROOT,
);

// ---- 4. 写版本号 ----
const version = resolveVersion();
const versionFile = join(RELEASE_DIR, "src", "version.generated.ts");
const versionContent = `/**\n * 构建时生成的版本号（由 release/build.ts 写入）。\n * 默认值随仓库提交，打包时自动替换为 tag / 环境变量指定的版本。\n */\nexport const APP_VERSION = '${version}';\n`;
if (!existsSync(versionFile) || readFileSyncSafe(versionFile) !== versionContent) {
  writeFileSync(versionFile, versionContent, "utf-8");
  console.log(`==> 版本号：${version}`);
}

// ---- 5. 编译单文件可执行版 ----
mkdirSync(OUTDIR, { recursive: true });
const outfile = join(OUTDIR, process.platform === "win32" && !NAME.endsWith(".exe") ? `${NAME}.exe` : NAME);
rmSync(outfile, { force: true });

const assets: string[] = [
  "server/prompts",
  "server/skills",
  "server/validation",
  "server/plugins",
  "web/dist",
];
if (existsSync(join(RELEASE_DIR, "vendor", "plugin"))) assets.push("release/vendor/plugin");

const buildArgs = [
  "build",
  "release/src/main.ts",
  "--compile",
  "--minify",
  "--outfile",
  outfile,
  ...(COMPILE_TARGET ? [`--target=${COMPILE_TARGET}`] : []),
  ...assets.map((a) => `--asset=${a}`),
];
console.log(`==> 编译单文件可执行版 → ${outfile}`);
console.log(`    （嵌入：${assets.join("、")}）`);
run(bunExecutable(), buildArgs, REPO_ROOT);

if (!existsSync(outfile)) throw new Error(`编译失败：未生成 ${outfile}`);
if (process.platform !== "win32") chmodSync(outfile, 0o755);
console.log(`\n==> 打包完成：${outfile}（${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB）`);
console.log(`    目标平台：${COMPILE_TARGET ?? "当前宿主"}；直接运行即启动服务器并自动打开浏览器。`);

function readFileSyncSafe(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}
