/**
 * UniBot Extension Studio 桌面客户端主进程（Electrobun / Bun runtime）。
 *
 * 职责：
 * 1. 从应用资源目录（PATHS.RESOURCES_FOLDER）定位打包内容：
 *    - server/dist/index.js   后端 bundle（Bun.serve + REST/WS + 静态服务）
 *    - web/                   前端构建产物（由后端同源提供）
 *    - opencode/opencode[.exe] 内置 opencode 二进制（安装即自带，无需用户另行安装）
 * 2. 以子进程方式启动后端（指定随机空闲端口、数据目录与静态目录），轮询就绪
 * 3. 打开桌面窗口加载 http://127.0.0.1:<port>/，退出时回收子进程
 *
 * 数据目录：Utils.paths.userData（按 app identifier + 渠道隔离，可写）。
 */
import { BrowserWindow, ApplicationMenu, PATHS, Utils } from "electrobun/main";
import Electrobun from "electrobun/main";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

const APP_TITLE = "UniBot Extension Studio";
const SERVER_START_TIMEOUT_MS = Number(
  process.env.STUDIO_SERVER_TIMEOUT_MS ?? 30_000,
);

/** 获取 OS 分配的空闲端口（与后端 opencode.ts 相同的做法） */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** 定位 Bun 可执行文件：优先当前进程（Electrobun 内置 Bun runtime），回退 PATH */
function bunExecutable(): string {
  if (process.execPath && process.execPath.length > 0) return process.execPath;
  try {
    // @ts-expect-error Bun 专有 API，devkit 类型可能未覆盖
    const fromBun = Bun.executablePath?.();
    if (typeof fromBun === "string" && fromBun.length > 0) return fromBun;
  } catch {
    // 忽略，回退 PATH
  }
  return "bun";
}

let serverProcess: ChildProcess | null = null;
let stopping = false;

function stopServer() {
  if (stopping) return;
  stopping = true;
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 服务尚未就绪，重试
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function startServer(): Promise<number> {
  const resources = PATHS.RESOURCES_FOLDER;
  const serverBundle = join(resources, "server", "dist", "index.js");
  const webDist = join(resources, "web");
  const opencodeBin = join(
    resources,
    "opencode",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
  const userData = Utils.paths.userData;
  const dataDir = join(userData, "studio-data");
  // 确保可写目录存在（userData 可能尚未创建，日志流与后端数据目录都依赖它）
  mkdirSync(userData, { recursive: true });

  if (!existsSync(serverBundle)) {
    throw new Error(`后端 bundle 缺失：${serverBundle}`);
  }
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(`前端构建产物缺失：${join(webDist, "index.html")}`);
  }

  const port = await getFreePort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    UNIBOT_STUDIO_HOST: "127.0.0.1",
    UNIBOT_STUDIO_PORT: String(port),
    UNIBOT_STUDIO_DATA_DIR: dataDir,
    UNIBOT_STUDIO_STATIC_DIR: webDist,
    OPENCODE_BIN: existsSync(opencodeBin) ? opencodeBin : (process.env.OPENCODE_BIN ?? "opencode"),
  };

  // 后端日志落盘（便于排查），同时镜像到 stdout
  const logStream = createWriteStream(join(userData, "studio-server.log"), {
    flags: "a",
  });
  serverProcess = spawn(bunExecutable(), [serverBundle], { env, stdio: ["ignore", "pipe", "pipe"] });

  serverProcess.stdout?.on("data", (d: Buffer) => {
    const line = d.toString();
    logStream.write(`[server] ${line}`);
    console.log(`[server] ${line.trimEnd()}`);
  });
  serverProcess.stderr?.on("data", (d: Buffer) => {
    const line = d.toString();
    logStream.write(`[server:err] ${line}`);
    console.error(`[server:err] ${line.trimEnd()}`);
  });
  serverProcess.on("error", (err) => {
    logStream.write(`[server:err] spawn 失败: ${err.message}\n`);
    console.error("无法启动后端进程：", err.message);
  });
  serverProcess.on("exit", (code, signal) => {
    logStream.write(`[server] 进程退出 code=${code} signal=${signal}\n`);
    if (!stopping) {
      console.error(`后端进程异常退出（code=${code}, signal=${signal}）`);
      if (!(globalThis as Record<string, unknown>).__quitRequested) {
        // 后端崩溃视为致命错误：退出应用（before-quit 会执行清理）
        process.exit(1);
      }
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const ready = await waitForHttp(`${baseUrl}/`, SERVER_START_TIMEOUT_MS);
  if (!ready) {
    stopServer();
    throw new Error(`后端启动超时（${SERVER_START_TIMEOUT_MS}ms）：${baseUrl}，详见 ${join(userData, "studio-server.log")}`);
  }
  console.log(`后端就绪：${baseUrl}（数据目录 ${dataDir}）`);
  return port;
}

async function main() {
  let port: number;
  try {
    port = await startServer();
  } catch (err) {
    console.error("启动失败：", (err as Error).message);
    Utils.showNotification({ title: APP_TITLE, body: `启动失败：${(err as Error).message}` });
    process.exit(1);
    return;
  }

  // 窗口加载后端的登录页（页面、REST、WS 全部同源）
  const win = new BrowserWindow({
    title: APP_TITLE,
    url: `http://127.0.0.1:${port}/`,
    frame: { width: 1280, height: 820 },
  });

  ApplicationMenu.setApplicationMenu([
    {
      label: APP_TITLE,
      submenu: [{ role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ]);

  // 退出清理：子进程回收（before-quit 为同步回调，kill 为同步操作，无需 await）
  Electrobun.events.on("before-quit", () => {
    (globalThis as Record<string, unknown>).__quitRequested = true;
    stopServer();
  });
  process.on("exit", () => {
    if (serverProcess && !serverProcess.killed) {
      try {
        serverProcess.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }
  });
  process.on("SIGINT", () => {
    stopServer();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopServer();
    process.exit(0);
  });

  void win;
}

void main();
