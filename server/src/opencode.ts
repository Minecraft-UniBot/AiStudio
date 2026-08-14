/**
 * OpenCode 网关：管理本机 `opencode serve` 子进程生命周期，并通过
 * `@opencode-ai/sdk` 提供类型安全的客户端访问。
 *
 * 安全约束（对应 Plan.md 8.x）：
 * - 仅监听 127.0.0.1，随机空闲端口
 * - 启动时生成高熵口令，仅保存在进程内存
 * - 独立 OpenCode 数据目录，避免与管理员个人会话混用
 * - 进程异常退出做有限次数退避重启
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { config } from './config';
import { logger } from './logger';

const OPENCODE_HEALTH_RETRIES = 60;
const OPENCODE_HEALTH_INTERVAL_MS = 500;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 2000;

/** 获取 OS 分配的空闲端口 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createTcpServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
    srv.on('error', reject);
  });
}

export interface OpenCodeStatus {
  available: boolean;
  version: string | null;
  url: string | null;
  error: string | null;
  restarts: number;
}

class OpenCodeGateway {
  private process: ChildProcess | null = null;
  private port = 0;
  private password = '';
  private url: string | null = null;
  private client: OpencodeClient | null = null;
  private restarts = 0;
  private status: OpenCodeStatus = {
    available: false,
    version: null,
    url: null,
    error: null,
    restarts: 0,
  };
  private stopping = false;

  getStatus(): OpenCodeStatus {
    return { ...this.status };
  }

  /** 获取 SDK 客户端；未就绪时抛出明确错误 */
  getClient(): OpencodeClient {
    if (!this.client || !this.status.available) {
      throw new Error('OpenCode 服务不可用，请检查后端诊断信息');
    }
    return this.client;
  }

  getDirectory(): string {
    return config.opencode.data_dir;
  }

  /** 启动 OpenCode 子进程并等待健康 */
  async start(): Promise<OpenCodeStatus> {
    this.stopping = false;
    await this.launch();
    return this.status;
  }

  private async launch() {
    const bin = config.opencode.bin;
    // 获取随机空闲端口
    this.port = await getFreePort();
    // 默认随机高熵口令；可用环境变量覆盖（便于调试/测试直连 opencode API）
    this.password = process.env.OPENCODE_SERVER_PASSWORD ?? randomBytes(24).toString('base64url');
    // 独立数据/配置目录（通过 XDG 变量隔离，不依赖固定 CLI 参数）
    const dataDir = config.opencode.data_dir;

    const args = [
      'serve',
      '--hostname', '127.0.0.1',
      '--port', String(this.port),
    ];
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENCODE_SERVER_PASSWORD: this.password,
      XDG_DATA_HOME: join(dataDir, 'data'),
      XDG_CONFIG_HOME: join(dataDir, 'config'),
      XDG_CACHE_HOME: join(dataDir, 'cache'),
    };

    this.process = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.url = `http://127.0.0.1:${this.port}`;
    logger.info('opencode', `启动 opencode serve（第 ${this.restarts + 1} 次尝试）`, {
      bin,
      port: this.port,
      data_dir: dataDir,
    });

    this.process.stdout?.on('data', (d: Buffer) => {
      if (process.env.UNIBOT_STUDIO_DEBUG) console.log('[opencode]', d.toString().trim());
    });
    this.process.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (process.env.UNIBOT_STUDIO_DEBUG) console.error('[opencode]', line);
    });
    this.process.on('exit', (code, signal) => {
      this.client = null;
      this.status.available = false;
      this.status.url = null;
      this.status.error = `OpenCode 进程退出 (code=${code}, signal=${signal})`;
      if (!this.stopping && this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        this.status.restarts = this.restarts;
        logger.warn('opencode', 'OpenCode 进程异常退出，准备重启', { code, signal, restarts: this.restarts });
        setTimeout(() => this.launch().catch(() => {}), RESTART_BACKOFF_MS * this.restarts);
      } else if (!this.stopping) {
        logger.error('opencode', 'OpenCode 进程退出且超过重启上限', { code, signal, restarts: this.restarts });
      }
    });
    this.process.on('error', (err) => {
      this.status.available = false;
      this.status.error = `无法启动 OpenCode：${err.message}`;
      logger.error('opencode', '无法启动 OpenCode', { error: err.message });
    });

    await this.waitHealthy();
  }

  private async waitHealthy(): Promise<void> {
    const auth = 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
    for (let i = 0; i < OPENCODE_HEALTH_RETRIES; i++) {
      if (this.stopping) return;
      try {
        const res = await fetch(`${this.url}/global/health`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(800),
        });
        if (res.ok) {
          const body = (await res.json()) as { version?: string };
          this.status.available = true;
          this.status.version = body.version ?? null;
          this.status.url = this.url;
          this.status.error = null;
          this.client = createOpencodeClient({
            baseUrl: this.url!,
            headers: { Authorization: auth },
          });
          logger.info('opencode', '健康检查通过', { version: body.version ?? '未知', url: this.url });
          return;
        }
      } catch {
        // 服务尚未就绪，重试
      }
      await Bun.sleep(OPENCODE_HEALTH_INTERVAL_MS);
    }
    this.status.available = false;
    this.status.error = 'OpenCode 健康检查超时';
  }

  /** 停止子进程（幂等） */
  async stop() {
    this.stopping = true;
    this.client = null;
    if (this.process && !this.process.killed) {
      logger.info('opencode', '停止 opencode serve 子进程');
      this.process.kill('SIGTERM');
      await Bun.sleep(300);
      if (!this.process.killed) this.process.kill('SIGKILL');
    }
    this.process = null;
    this.status = {
      available: false,
      version: null,
      url: null,
      error: null,
      restarts: 0,
    };
  }
}

export const opencode = new OpenCodeGateway();
