/**
 * UniBot Extension Studio 单文件可执行版启动器。
 *
 * 与桌面客户端（Electrobun）同源的「后端 + 前端」一体应用，但打包为单个
 * 可执行文件（bun build --compile），无需安装、无需 WebView 运行时、
 * 不需要 hutch / Electrobun（后者也不支持 macOS x64 / 单文件形态）。
 *
 * 启动流程：
 * 1. 内置资源（server bundle + web/dist + prompts + skills + validation）首次运行
 *    解压到数据目录（<DATA_DIR>/portable/resources/），版本戳变化（升级 exe）时自动重新解压
 * 2. 定位 opencode 引擎（优先级：OPENCODE_BIN 环境变量 → exe 同目录 → 上次下载），
 *    都没有则首次运行自动从 npm registry 下载（约 40-50MB）
 * 3. 挑选随机空闲端口，设置环境变量后以「运行时文件 import」加载后端 bundle
 *    （与桌面版一致使用 stage 出的 server/dist/index.js，避免编译期内联
 *    顶层 await 永不结束模块带来的启动语义问题）
 * 4. 自动打开系统浏览器访问工坊；Ctrl-C / Cmd-C 即退出（回收 opencode 子进程）
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSETS, BUILD_STAMP, OPENCODE_VERSION } from './generated-assets';

const APP_TITLE = 'UniBot Extension Studio';
const BIN_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
const DEBUG = process.env.UNIBOT_STUDIO_DEBUG === '1';
const dbg = (msg: string) => {
  if (DEBUG) console.log(`[debug] ${msg}`);
};

/** 获取 OS 分配的空闲端口（与后端 opencode.ts 相同的做法） */
function getFreePort(): Promise<number> {
  dbg('getFreePort: 开始 listen');
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, '127.0.0.1', () => {
      dbg('getFreePort: listen 回调触发');
      const address = srv.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
      srv.close();
    });
    srv.on('error', (err) => {
      dbg('getFreePort: 出错 ' + (err as Error).message);
      reject(err);
    });
  });
}

/** 解压内置资源到 <数据目录>/portable/resources/（版本戳不同才重解压） */
async function ensureResources(dataDir: string): Promise<string> {
  const resourcesDir = join(dataDir, 'portable', 'resources');
  const stampFile = join(resourcesDir, '.stamp');
  try {
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf-8') === BUILD_STAMP) {
      return resourcesDir;
    }
  } catch {
    // 版本戳损坏则重新解压
  }
  console.log(`==> 首次运行 / 版本更新：解压内置资源（${ASSETS.length} 个文件）`);
  rmSync(resourcesDir, { recursive: true, force: true });
  mkdirSync(resourcesDir, { recursive: true });
  for (const [rel, embedded] of ASSETS) {
    const target = join(resourcesDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    await Bun.write(target, Bun.file(embedded));
  }
  // UNIBOT_STUDIO_RES_DIR 指向的 src 基准目录（对应 server/src，用于定位上级资源）
  mkdirSync(join(resourcesDir, 'src'), { recursive: true });
  writeFileSync(stampFile, BUILD_STAMP, 'utf-8');
  return resourcesDir;
}

/** 已存在可用的 opencode 二进制（含可执行位检查） */
function findExistingOpencode(dataDir: string): string | null {
  const candidates: string[] = [];
  if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN);
  candidates.push(join(dirname(process.execPath), BIN_NAME)); // exe 同目录
  candidates.push(join(dataDir, 'portable', 'opencode', BIN_NAME)); // 上次自动下载
  for (const c of candidates) {
    try {
      const st = statSync(c);
      if (st.size > 1024 * 1024 && (process.platform === 'win32' || (st.mode & 0o111) !== 0)) {
        return c;
      }
    } catch {
      // 不存在则尝试下一个候选
    }
  }
  return null;
}

/** 从 npm registry 下载 opencode 平台二进制（与 desktop/scripts/fetch-opencode.ts 同源逻辑） */
async function downloadOpencode(destFile: string, version: string): Promise<boolean> {
  const arch = process.arch;
  const osPkg =
    process.platform === 'darwin'
      ? arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
      : process.platform === 'linux'
        ? arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
        : arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
  const pkg = `opencode-${osPkg}`;
  const tmpDir = join(dirname(destFile), `.tmp-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const archive = join(tmpDir, `${pkg}.tgz`);
  try {
    const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
    console.log(`==> 首次运行：自动下载 opencode v${version}（${pkg}，约 40-50MB）…`);
    console.log(`    来源：${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`下载失败：HTTP ${res.status}（${url}）`);
      return false;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    console.log(`    已下载 ${(bytes.length / 1024 / 1024).toFixed(1)} MB，解压中…`);
    writeFileSync(archive, bytes);
    const extract = spawnSync('tar', ['-xzf', archive, '-C', tmpDir], { stdio: 'inherit' });
    if (extract.status !== 0) {
      console.error('opencode 归档解压失败');
      return false;
    }
    const found = join(tmpDir, 'package', 'bin', BIN_NAME);
    if (!existsSync(found)) {
      console.error(`解压结果中未找到 ${BIN_NAME}`);
      return false;
    }
    mkdirSync(dirname(destFile), { recursive: true });
    await Bun.write(destFile, Bun.file(found));
    if (process.platform !== 'win32') chmodSync(destFile, 0o755);
    console.log(`==> opencode 就绪：${destFile}`);
    return true;
  } catch (err) {
    console.error(`opencode 下载失败：${(err as Error).message}`);
    return false;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 打开系统浏览器 */
function openBrowser(url: string) {
  if (process.env.UNIBOT_STUDIO_NO_OPEN_BROWSER === '1') return;
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    spawn(cmd[0]!, cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {
    console.log(`浏览器未自动打开，请手动访问：${url}`);
  }
}

/** 轮询 HTTP 就绪（与桌面版主进程相同的策略） */
async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const debug = process.env.UNIBOT_STUDIO_DEBUG === '1';
  const deadline = Date.now() + timeoutMs;
  let n = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status !== 502 && res.status !== 503) return true;
    } catch (err) {
      if (debug && n % 5 === 0) console.log(`[debug] 等待后端就绪… ${(err as Error).message}`);
    }
    await Bun.sleep(300);
    n += 1;
  }
  return false;
}

async function main() {
  console.log(`==> ${APP_TITLE}（单文件版）启动中…`);
  const dataDir = process.env.UNIBOT_STUDIO_DATA_DIR ?? join(homedir(), '.unibot-studio');

  // 1. 解压内置资源（web 前端 + prompts/skills/validation）
  const resourcesDir = await ensureResources(dataDir);

  // 2. opencode 引擎：已有则复用，否则自动下载
  let opencodeBin = findExistingOpencode(dataDir);
  if (!opencodeBin) {
    const dest = join(dataDir, 'portable', 'opencode', BIN_NAME);
    const ok = await downloadOpencode(dest, OPENCODE_VERSION);
    if (ok) {
      opencodeBin = dest;
    } else {
      console.warn(
        '⚠ opencode 下载失败：工坊仍会打开，但 AI 生成功能不可用。\n' +
          '  可稍后重试：删除 ' +
          dest +
          ' 后重新启动本程序；或设置 OPENCODE_BIN 指向本地 opencode 可执行文件。',
      );
    }
  } else {
    console.log(`==> 使用已有 opencode：${opencodeBin}`);
  }

  // 3. 随机空闲端口 + 环境变量（后端 config.ts 读取）
  const port = await getFreePort();
  dbg(`已选端口 ${port}`);
  process.env.UNIBOT_STUDIO_HOST = '127.0.0.1';
  process.env.UNIBOT_STUDIO_PORT = String(port);
  process.env.UNIBOT_STUDIO_DATA_DIR = dataDir;
  process.env.UNIBOT_STUDIO_STATIC_DIR = join(resourcesDir, 'web');
  process.env.UNIBOT_STUDIO_RES_DIR = join(resourcesDir, 'src');
  if (opencodeBin) process.env.OPENCODE_BIN = opencodeBin;

  // 4. 以「运行时文件 import」加载后端 bundle（与桌面版同一份 stage 产物）。
  //    注意：后端模块顶层 await 含永不结束的协调循环（startEventConsumer），
  //    import 的 Promise 不会 resolve——因此不 await，改为轮询 HTTP 就绪
  //    （与桌面版主进程 waitForHttp 策略一致）。
  const serverBundle = join(resourcesDir, 'server', 'index.js');
  if (!existsSync(serverBundle)) {
    console.error(`后端 bundle 缺失：${serverBundle}（重新构建单文件版）`);
    process.exit(1);
  }
  dbg('开始加载后端 bundle：' + serverBundle);
  import(pathToFileURL(serverBundle).href).catch((err) => {
    console.error('后端加载失败：', (err as Error).message);
    process.exit(1);
  });
  dbg('已发起后端模块加载');

  const url = `http://127.0.0.1:${port}`;
  if (!(await waitForHttp(url, 30_000))) {
    console.error(`后端启动超时：${url}`);
    console.error('设置 UNIBOT_STUDIO_DEBUG=1 后重启可查看详细日志；数据目录：' + dataDir);
    process.exit(1);
  }
  console.log(`\n==> 后端就绪：${url}`);
  console.log(`==> 数据目录：${dataDir}`);
  console.log(`==> 正在打开浏览器…（关闭本窗口或按 Ctrl-C 退出工坊）`);
  openBrowser(url);
}

// Ctrl-C / 终止信号：先走 process 'exit' 清理（后端注册的兜底会 SIGKILL opencode
// 子进程，避免残留实例），再退出进程。后端的 SIGINT/SIGTERM 处理器注册在
// startEventConsumer 之后（永不执行），因此退出回收必须由启动器负责。
let stopping = false;
function onShutdownSignal() {
  if (stopping) return;
  stopping = true;
  console.log('\n==> 正在退出，回收 opencode 子进程…');
  process.exit(0);
}
process.on('SIGINT', onShutdownSignal);
process.on('SIGTERM', onShutdownSignal);

void main();