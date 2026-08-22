/**
 * opencode 二进制获取：首次启动时自动下载到数据目录（单文件版不再内置 opencode，
 * 减小安装包体积；下载一次后带版本标记复用，版本升级自动重新下载）。
 *
 * 来源：npm registry 平台二进制包（opencode-<os>-<arch>，与 `npm i -g opencode-ai`
 * 安装的是同一份二进制），与发布工作流 / 旧 fetch 脚本同一来源。
 *
 * 解析优先级（ensureOpencodeBin）：
 *   1. OPENCODE_BIN 环境变量指向的已存在文件
 *   2. 数据目录已下载且版本匹配的本地副本
 *   3. 开发模式（非独立可执行）：PATH 中的 opencode（沿用安装版，不强制下载）
 *   4. 否则下载到 <数据目录>/opencode-bin/
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { config } from './config';
import { logger } from './logger';

const BIN_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
/** 版本标记文件名：内容为下载的 opencode 版本，用于判断是否需要重新下载 */
const VERSION_MARKER = '.opencode-version';
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function isStandalone(): boolean {
  // Bun >= 1.4 提供该属性；源码运行（dev）时为 undefined
  return (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true;
}

/** 本地 opencode 二进制目录（数据目录下，独立于 opencode 自身的 XDG data） */
export function opencodeBinDir(): string {
  return join(config.data_dir, 'opencode-bin');
}

/** 本地 opencode 二进制路径 */
export function opencodeLocalBin(): string {
  return join(opencodeBinDir(), BIN_NAME);
}

interface PlatformSpec {
  /** npm 平台包名（opencode-<os>-<arch>） */
  pkg: string;
}

function platformSpec(): PlatformSpec {
  const arch = process.arch; // x64 | arm64
  if (process.platform === 'darwin') {
    return { pkg: `opencode-darwin-${arch === 'arm64' ? 'arm64' : 'x64'}` };
  }
  if (process.platform === 'linux') {
    return { pkg: `opencode-linux-${arch === 'arm64' ? 'arm64' : 'x64'}` };
  }
  if (process.platform === 'win32') {
    return { pkg: `opencode-windows-${arch === 'arm64' ? 'arm64' : 'x64'}` };
  }
  throw new Error(`不支持的平台：${process.platform}/${arch}`);
}

/**
 * 确保 opencode 可执行文件可用，返回最终 bin 路径。
 * 下载失败时抛错（调用方降级：opencode 不可用但服务器继续运行）。
 */
export async function ensureOpencodeBin(): Promise<string> {
  // 1. OPENCODE_BIN 显式指定且文件存在 → 直接使用
  const explicit = process.env.OPENCODE_BIN;
  if (explicit && existsSync(explicit)) return explicit;

  // 2. 数据目录已有本地副本且版本匹配 → 复用
  const local = opencodeLocalBin();
  const marker = join(opencodeBinDir(), VERSION_MARKER);
  if (existsSync(local)) {
    const current = existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : '';
    if (current === config.opencode.version) return local;
    logger.info('opencode', `本地 opencode 版本（${current || '未知'}）与期望（${config.opencode.version}）不一致，重新下载`);
    rmSync(opencodeBinDir(), { recursive: true, force: true });
  }

  // 3. 开发模式（源码运行）：PATH 中有 opencode 则沿用，不强制下载
  if (!isStandalone()) {
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['opencode'], { stdio: 'ignore' });
    if (probe.status === 0) return 'opencode';
  }

  // 4. 首次启动：下载到数据目录
  return downloadOpencode(opencodeBinDir(), config.opencode.version);
}

/** 从 npm registry 下载平台二进制并解压，返回可执行文件路径 */
async function downloadOpencode(destDir: string, version: string): Promise<string> {
  const spec = platformSpec();
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });

  const tmpDir = join(destDir, `.tmp-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, `${spec.pkg}.tgz`);
  const url = `https://registry.npmjs.org/${spec.pkg}/-/${spec.pkg}-${version}.tgz`;

  logger.info('opencode', `首次启动：正在下载 opencode v${version}（约 45MB，仅此一次）…`);
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`下载 opencode 失败（HTTP ${res.status}）：${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(archive, bytes);
  logger.info('opencode', `opencode 已下载（${(bytes.length / 1024 / 1024).toFixed(1)} MB），正在解压…`);

  // npm tgz 是 tar 格式。Windows 用 System32 的 bsdtar（Git 自带 GNU tar 会把
  // "D:\..." 绝对路径误判为远程主机名），且用 cwd=tmpDir + 相对归档名规避盘符冒号。
  const isWindows = process.platform === 'win32';
  const extract = isWindows
    ? ['tar', '-xf', basename(archive)]
    : ['tar', '-xzf', archive, '-C', tmpDir];
  const run = spawnSync(extract[0]!, extract.slice(1), {
    cwd: isWindows ? tmpDir : undefined,
    stdio: 'ignore',
  });
  if (run.status !== 0) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`解压 opencode 失败：${extract.join(' ')}`);
  }

  // 在解压目录中定位可执行文件（npm 包位于 package/bin/opencode）
  const found = findBinary(tmpDir);
  if (!found) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('解压结果中未找到 opencode 可执行文件');
  }

  const dest = join(destDir, BIN_NAME);
  writeFileSync(dest, new Uint8Array(await Bun.file(found).arrayBuffer()));
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
  writeFileSync(join(destDir, VERSION_MARKER), version + '\n', 'utf-8');
  rmSync(tmpDir, { recursive: true, force: true });

  logger.info('opencode', `内置 opencode 已就绪：${dest}`);
  return dest;
}

function findBinary(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(full);
      if (nested) return nested;
    } else if (
      !/\.(tgz|zip|tar\.gz)$/.test(entry.name) &&
      (entry.name === BIN_NAME || (entry.name.startsWith('opencode') && !entry.name.endsWith('.json')))
    ) {
      return full;
    }
  }
  return null;
}
