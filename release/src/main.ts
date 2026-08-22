#!/usr/bin/env bun
/**
 * UniBot Extension Studio —— 单文件可执行版入口。
 *
 * 一个二进制 = 后端（server 全部源码与依赖）+ 前端（web/dist）+ 内置资源
 * （prompts / skills / validation / plugins）。opencode 不内置（减小体积）：
 * 首次启动时由后端自动下载到 <数据目录>/opencode-bin/（见 server/src/opencode_download.ts）。
 * 运行即「初始化 + 启动服务器」，不需要用户做任何额外操作：
 *
 *   1. 解析数据目录（UNIBOT_STUDIO_DATA_DIR ?? ~/.unibot-studio）
 *   2. 默认端口 9876 被占用时自动改换空闲端口（也可用 UNIBOT_STUDIO_PORT 指定）
 *   3. 把内置资源解压到 <数据目录>/resources（带版本标记，升级后自动重新解压）
 *   4. 用 UNIBOT_STUDIO_RES_DIR / UNIBOT_STUDIO_STATIC_DIR 把后端与静态页指向解压产物
 *   5. 在同一进程内启动后端（REST / WebSocket / 前端静态页全部同源）
 *   6. 打印访问地址与口令，并自动打开浏览器
 *
 * 资源嵌入方式：bun build --compile --asset=<目录>（Bun >= 1.4 的 compile.assets），
 * 运行时位于 import.meta.dir 下的原始相对路径，可用 node:fs 读取。因为
 * validation 脚本要交给 python 子进程，必须先解压到真实文件系统，再让后端
 * 通过环境变量引用（见 server/src/config.ts 对 UNIBOT_STUDIO_RES_DIR 的说明）。
 *
 * 注意：本文件不能在模块顶层 import 任何 server 模块——env 必须在
 * 动态 import server 入口（../../server/src/index.ts）之前设置完毕，
 * 否则 config 模块会在 import 时读到未覆盖的配置。
 */
import { homedir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from './version.generated';

// ---- 常量 ----

const DEFAULT_PORT = 9876;
const EMBEDDED_RES_DIR = 'studio-resources'; // 无实际意义，仅文档化：资源在 import.meta.dir 下的相对路径

/** 后端解压后的目录名（数据目录下） */
const RESOURCES_DIR_NAME = 'resources';

/** 解压标记文件名：内容为嵌入版本号，用于判断是否需要重新解压 */
const VERSION_MARKER = '.studio-version';

// ---- 工具函数 ----

function log(message: string) {
  console.log(`[studio] ${message}`);
}

function warn(message: string) {
  console.warn(`[studio] ${message}`);
}

/** 判断当前进程是否是编译后的独立可执行文件 */
function isStandalone(): boolean {
  // Bun >= 1.4 提供 Bun.isStandaloneExecutable；低版本视为非独立（走源码运行）
  return (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true;
}

/** 解析平台数据目录（与 server/src/config.ts 的默认值一致） */
function resolveDataDir(): string {
  return process.env.UNIBOT_STUDIO_DATA_DIR || join(homedir(), '.unibot-studio');
}

/** 获取 OS 分配的空闲端口 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === 'object' && address ? address.port : DEFAULT_PORT));
    });
    srv.on('error', reject);
  });
}

/** 探测指定端口是否空闲 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createTcpServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * 把嵌入资源树复制到真实文件系统。
 * 递归遍历 import.meta.dir 下的嵌入目录（bunfs 虚拟文件系统，node:fs 可读），
 * 逐个文件写出 —— python / opencode 子进程需要真实路径。
 */
function extractTree(src: string, dest: string): boolean {
  if (!existsSync(src) || !statSync(src).isDirectory()) return false;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      extractTree(s, d);
    } else if (entry.isFile()) {
      // bunfs 虚拟文件系统不支持 copyFileSync，必须 读→写
      writeFileSync(d, readFileSync(s));
    }
  }
  return true;
}

/** 打开系统默认浏览器（尽力而为，失败不阻塞） */
function openBrowser(url: string) {
  if (process.env.UNIBOT_STUDIO_NO_BROWSER === '1') return;
  try {
    const win = process.platform === 'win32';
    const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = win ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // 忽略：无浏览器环境（如无头服务器）时仅打印地址
  }
}

/** 等待服务器 HTTP 就绪（登录页静态资源无需认证，直接 GET / ） */
async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 服务未就绪，重试
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---- 主流程 ----

async function main(): Promise<void> {
  // 命令行参数
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`UniBot Extension Studio ${APP_VERSION}`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`UniBot Extension Studio ${APP_VERSION}`);
    console.log('');
    console.log('用法：unibot-studio [--version] [--help]');
    console.log('');
    console.log('运行即启动本地服务器（默认 http://127.0.0.1:9876），自动打开浏览器。');
    console.log('环境变量：');
    console.log('  UNIBOT_STUDIO_PORT       端口（默认 9876，被占用自动换空闲端口）');
    console.log('  UNIBOT_STUDIO_HOST       监听地址（默认 127.0.0.1）');
    console.log('  UNIBOT_STUDIO_DATA_DIR   数据目录（默认 ~/.unibot-studio）');
    console.log('  UNIBOT_STUDIO_PASSWORD   访问口令（默认首次启动自动生成）');
    console.log('  UNIBOT_STUDIO_NO_BROWSER 设为 1 时不自动打开浏览器');
    return;
  }

  // ---- 1. 数据目录与端口 ----
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  let port = Number(process.env.UNIBOT_STUDIO_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    warn(`无效端口 ${process.env.UNIBOT_STUDIO_PORT}，使用默认端口 ${DEFAULT_PORT}`);
    port = DEFAULT_PORT;
  }
  if (!process.env.UNIBOT_STUDIO_PORT && !(await isPortFree(port))) {
    const free = await getFreePort();
    warn(`端口 ${port} 已被占用，自动改用空闲端口 ${free}`);
    port = free;
  }
  process.env.UNIBOT_STUDIO_PORT = String(port);

  // ---- 2/3. 解压内置资源 + 指向解压产物（仅独立可执行模式） ----
  // 非独立模式（`bun release/src/main.ts` 源码调试）不注入任何环境变量，
  // 后端回退到 import.meta.dir 定位源码资源（开发请直接 `cd server && bun src/index.ts`）。
  const standalone = isStandalone();
  if (standalone) {
    const resourcesDir = join(dataDir, RESOURCES_DIR_NAME);
    try {
      const marker = join(resourcesDir, VERSION_MARKER);
      const current =
        existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : '';
      if (current !== APP_VERSION) {
        log(`初始化内置资源（v${APP_VERSION}）→ ${resourcesDir}`);
        const tmp = `${resourcesDir}.tmp-${process.pid}`;
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        const root = import.meta.dir; // /$bunfs/root，嵌入目录以 basename 为根（见 build.ts 的 --asset）
        // [嵌入根, 解压目标]：--asset=server/prompts → 嵌入在 prompts/，目标 resources/server/prompts
        // （后端 resSrcDir()=<res>/server/src，其兄弟目录为 prompts/skills/validation/plugins）
        const embedded: Array<[string, string]> = [
          ['prompts', join('server', 'prompts')],
          ['skills', join('server', 'skills')],
          ['validation', join('server', 'validation')],
          ['plugins', join('server', 'plugins')],
          ['plugin', join('server', 'plugins')], // 预打包的 unibot-tools.js（与源码同目录，后端优先用预打包产物）
          ['dist', 'web'],
        ];
        let any = false;
        for (const [srcRel, destRel] of embedded) {
          if (extractTree(join(root, srcRel), join(tmp, destRel))) any = true;
        }
        writeFileSync(join(tmp, VERSION_MARKER), APP_VERSION + '\n', 'utf-8');
        rmSync(resourcesDir, { recursive: true, force: true });
        renameSync(tmp, resourcesDir);
        if (!any) warn('未找到内置资源（可能未用 --asset 打包），部分功能可能不可用');
      }
    } catch (e) {
      // 解压失败不致命：后端仍可能可用
      warn(`内置资源解压失败：${(e as Error).message}`);
    }

    // resSrcDir() = UNIBOT_STUDIO_RES_DIR || import.meta.dir；路径约定为 <res>/../prompts 等，
    // 因此这里指向 resources/server/src，其兄弟目录为 prompts/skills/validation/plugins。
    const serverSrcDir = join(resourcesDir, 'server', 'src');
    mkdirSync(serverSrcDir, { recursive: true });
    process.env.UNIBOT_STUDIO_RES_DIR = serverSrcDir;
    process.env.UNIBOT_STUDIO_STATIC_DIR = join(resourcesDir, 'web');
    // opencode 不再内置：首次启动时由后端自动下载到 <数据目录>/opencode-bin/（见
    // server/src/opencode_download.ts），这里不注入 OPENCODE_BIN。
  }

  // ---- 4. 把日志同时落盘（<数据目录>/logs/studio.log），双击运行也能事后排查 ----
  try {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'studio.log');
    const tee = (line: string) => {
      try {
        writeFileSync(logFile, line + '\n', { flag: 'a' });
      } catch {
        // 忽略写日志失败
      }
    };
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    console.log = (...xs: unknown[]) => {
      const line = xs.map(String).join(' ');
      origLog(...xs);
      tee(line);
    };
    console.warn = (...xs: unknown[]) => {
      const line = xs.map(String).join(' ');
      origWarn(...xs);
      tee(line);
    };
    console.error = (...xs: unknown[]) => {
      const line = xs.map(String).join(' ');
      origError(...xs);
      tee(line);
    };
  } catch {
    // 日志落盘失败不影响启动
  }

  // ---- 5. 启动后端（动态 import：等 env 全部就绪后再加载 server 模块） ----
  log(`正在启动 UniBot Extension Studio v${APP_VERSION} …（数据目录 ${dataDir}）`);
  try {
    await import('../../server/src/index.ts');
  } catch (e) {
    console.error(`启动失败：${(e as Error).message}`);
    console.error(`详细日志：${join(dataDir, 'logs', 'studio.log')}`);
    process.exit(1);
  }

  // ---- 6. 就绪提示 + 自动打开浏览器 ----
  const url = `http://127.0.0.1:${port}/`;
  await waitForHttp(url, 30_000);
  log(`已就绪：${url}（Ctrl+C 停止）`);
  openBrowser(url);
}

void main();
