#!/usr/bin/env bun
/**
 * 下载并解压 opencode 可执行文件到 desktop/vendor/opencode/（桌面客户端“安装自带 opencode”）。
 *
 * 用法：
 *   bun scripts/fetch-opencode.ts [--version 1.18.18] [--force] [--source=npm|github]
 * 环境变量：OPENCODE_VERSION（默认 1.18.18，与 server 固定版本一致）
 *
 * 默认从 npm registry 获取平台二进制包（opencode-ai 的 optionalDependencies，
 * 含 opencode-darwin-{arm64,x64} / opencode-linux-{x64,arm64} / opencode-windows-{x64,arm64}），
 * 与 `npm install -g opencode-ai` 安装的是同一份二进制，且在 CI 中比 GitHub Releases 更稳定。
 * GitHub Releases 作为备选源（--source=github，版本需带 v 前缀，如 v1.18.18）。
 *
 * 解压后把可执行文件（opencode / opencode.exe）安置到 vendor/opencode/，unix 下 chmod +x。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_DIR = join(import.meta.dir, "..");
const VENDOR_OPENCODE = join(DESKTOP_DIR, "vendor", "opencode");
const BIN_NAME = process.platform === "win32" ? "opencode.exe" : "opencode";
const DEST = join(VENDOR_OPENCODE, BIN_NAME);

const args = process.argv.slice(2);
const versionArg = args.find((a) => a.startsWith("--version="))?.split("=")[1];
const sourceArg = args.find((a) => a.startsWith("--source="))?.split("=")[1];
const force = args.includes("--force");
const version = (versionArg ?? process.env.OPENCODE_VERSION ?? "1.18.18").replace(/^v/, "");
const source = sourceArg ?? process.env.OPENCODE_SOURCE ?? "npm";

interface PlatformSpec {
  /** npm 平台包名（opencode-<os>-<arch>） */
  pkg: string;
  /** GitHub Releases 资产名 */
  githubAsset: string;
}

function platformSpec(): PlatformSpec {
  const arch = process.arch; // x64 | arm64
  if (process.platform === "darwin") {
    const os = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    return { pkg: `opencode-${os}`, githubAsset: `opencode-${os}.zip` };
  }
  if (process.platform === "linux") {
    const os = arch === "arm64" ? "linux-arm64" : "linux-x64";
    return { pkg: `opencode-${os}`, githubAsset: `opencode-${os}.tar.gz` };
  }
  if (process.platform === "win32") {
    const os = arch === "arm64" ? "windows-arm64" : "windows-x64";
    return { pkg: `opencode-${os}`, githubAsset: `opencode-${os}.zip` };
  }
  throw new Error(`不支持的平台：${process.platform}/${arch}`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await awaitFetch(url);
  if (!res) throw new Error(`下载失败：${url}`);
  writeFileSync(dest, new Uint8Array(res));
  console.log(`==> 已下载 ${(res.length / 1024 / 1024).toFixed(1)} MB`);
}

// fetch 的同步封装（脚本顶层 await 亦可，这里统一错误处理）
async function awaitFetch(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`下载失败：HTTP ${res.status} ${url}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error(`下载失败：${(err as Error).message} ${url}`);
    return null;
  }
}

if (existsSync(DEST) && !force) {
  console.log(`opencode 已存在：${DEST}（--force 可重新下载）`);
  process.exit(0);
}

// 清理之前中断下载残留的临时目录（首次运行 vendor/ 尚不存在，跳过清理）
if (existsSync(VENDOR_OPENCODE)) {
  for (const entry of readdirSync(VENDOR_OPENCODE, { withFileTypes: true })) {
    if (entry.name.startsWith(".tmp-")) {
      rmSync(join(VENDOR_OPENCODE, entry.name), { recursive: true, force: true });
    }
  }
}

const spec = platformSpec();
const tmpDir = join(VENDOR_OPENCODE, ".tmp-" + Date.now());
mkdirSync(tmpDir, { recursive: true });
const archive = join(tmpDir, source === "github" ? spec.githubAsset : `${spec.pkg}.tgz`);

if (source === "npm") {
  const url = `https://registry.npmjs.org/${spec.pkg}/-/${spec.pkg}-${version}.tgz`;
  console.log(`==> 从 npm 下载 ${url}`);
  await download(url, archive);
} else if (source === "github") {
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${spec.githubAsset}`;
  console.log(`==> 从 GitHub Releases 下载 ${url}`);
  await download(url, archive);
} else {
  throw new Error(`未知下载源：${source}（可选 npm / github）`);
}
if (!existsSync(archive)) throw new Error("下载失败，未生成归档文件");

// npm tgz 与 GitHub tar.gz 均为 tar 格式；GitHub zip 用系统 unzip 或 Windows bsdtar
const extractCmd =
  source === "github" && spec.githubAsset.endsWith(".zip") && process.platform !== "win32"
    ? ["unzip", "-o", archive, "-d", tmpDir]
    : process.platform === "win32"
      ? ["tar", "-xf", archive, "-C", tmpDir]
      : ["tar", "-xzf", archive, "-C", tmpDir];
const run = spawnSync(extractCmd[0]!, [...extractCmd.slice(1)], { stdio: "inherit" });
if (run.status !== 0) throw new Error(`解压失败：${extractCmd.join(" ")}`);

// 在解压目录中定位可执行文件（npm 包位于 package/bin/opencode，GitHub 资产为顶层二进制）
function findBinary(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const nested = findBinary(full);
      if (nested) return nested;
    } else if (
      /\.(tgz|zip|tar\.gz)$/.test(e.name) === false &&
      (e.name === BIN_NAME || (e.name.startsWith("opencode") && !e.name.endsWith(".json")))
    ) {
      return full;
    }
  }
  return null;
}

const found = findBinary(tmpDir);
if (!found) throw new Error(`解压结果中未找到 ${BIN_NAME}`);
mkdirSync(VENDOR_OPENCODE, { recursive: true });
const data = await Bun.file(found).arrayBuffer();
writeFileSync(DEST, new Uint8Array(data));
if (process.platform !== "win32") chmodSync(DEST, 0o755);

rmSync(tmpDir, { recursive: true, force: true });
console.log(`==> 内置 opencode 就绪：${DEST}`);
console.log(`    （bun scripts/fetch-opencode.ts --force 可重下）`);
