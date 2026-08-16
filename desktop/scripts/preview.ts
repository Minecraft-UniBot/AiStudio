#!/usr/bin/env bun
/**
 * 桌面模式预览：在浏览器中模拟桌面客户端的运行方式。
 *
 * 与 src/bun/index.ts 的主进程使用相同的启动参数：
 *   - 运行打包好的后端 bundle（vendor/server/dist/index.js）
 *   - 前端由后端同源提供（UNIBOT_STUDIO_STATIC_DIR=vendor/web）
 *   - 使用内置 opencode（vendor/opencode/）
 * 区别：不开原生窗口，而是自动打开系统浏览器；数据目录沿用默认 ~/.unibot-studio（与 web 开发模式共享，方便调试）。
 *
 * 适用于本机无法运行 electrobun 的情况（如 Intel Mac：Electrobun 2.x 不发布 Darwin x64），
 * 或只想快速跑一遍「安装包里的实际代码」。
 *
 * 用法：bun run preview
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

const DESKTOP_DIR = join(import.meta.dir, "..");
const VENDOR = join(DESKTOP_DIR, "vendor");
const SERVER_START_TIMEOUT_MS = Number(process.env.STUDIO_SERVER_TIMEOUT_MS ?? 30_000);

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

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 尚未就绪
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { stdio: "ignore" }).unref();
  }
}

async function main(): Promise<void> {
  // 1. 确保打包输入就绪（后端 bundle + 前端 + 内置 opencode）
  const staged = spawnSync("bun", ["scripts/stage.ts"], { cwd: DESKTOP_DIR, stdio: "inherit" });
  if (staged.status !== 0) process.exit(staged.status ?? 1);

  const serverBundle = join(VENDOR, "server", "dist", "index.js");
  const webDist = join(VENDOR, "web");
  const opencodeBin = join(
    VENDOR,
    "opencode",
    process.platform === "win32" ? "opencode.exe" : "opencode",
  );
  if (!existsSync(serverBundle) || !existsSync(join(webDist, "index.html"))) {
    console.error("打包输入不完整：请先执行 bun scripts/fetch-opencode.ts 与 bun scripts/stage.ts");
    process.exit(1);
  }

  // 2. 与桌面主进程相同的 env，启动后端 bundle
  const port = await getFreePort();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    UNIBOT_STUDIO_HOST: "127.0.0.1",
    UNIBOT_STUDIO_PORT: String(port),
    UNIBOT_STUDIO_STATIC_DIR: webDist,
    OPENCODE_BIN: existsSync(opencodeBin) ? opencodeBin : (process.env.OPENCODE_BIN ?? "opencode"),
  };
  const bunBin = process.execPath || "bun";
  const child = spawn(bunBin, [serverBundle], { env, stdio: "inherit" });

  const baseUrl = `http://127.0.0.1:${port}`;
  const ready = await waitForHttp(`${baseUrl}/`, SERVER_START_TIMEOUT_MS);
  if (!ready) {
    console.error(`后端启动超时（${SERVER_START_TIMEOUT_MS}ms）：${baseUrl}`);
    child.kill("SIGTERM");
    process.exit(1);
  }

  console.log(`\n==> 桌面模式预览就绪：${baseUrl}（Ctrl+C 退出）\n`);
  openBrowser(`${baseUrl}/`);

  child.on("exit", (code) => {
    console.log(`后端进程退出（code=${code}），预览结束`);
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => {
    child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

void main();
