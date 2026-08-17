/**
 * OpenCode 网关：管理本机 `opencode serve` 子进程生命周期，并通过
 * 官方 `@opencode-ai/sdk` 提供类型安全的客户端访问。
 *
 * 按 SDK 文档（https://opencode.ai/docs/sdk）的约定：
 * - 客户端用 `createOpencodeClient({ baseUrl, headers, throwOnError })` 创建，
 *   `throwOnError: true` 让 API 错误抛出带 `.message` 的 Error，调用方用 try/catch 处理
 *   （见 SDK 文档 Errors 一节；错误原体与状态码在 `error.cause`）。
 * - 事件流用 `client.event.subscribe({ query: { directory }, signal, onSseEvent })`，
 *   与 SDK 文档 Events 一节一致（见 events.ts）。
 *
 * 为什么不直接用 SDK 的 `createOpencodeServer()`：
 * SDK 内建启动器不支持本项目安全模型所需的定制：
 * - `OPENCODE_SERVER_PASSWORD` 高熵口令（只存进程内存）
 * - XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME 独立数据目录隔离
 * - `OPENCODE_BIN` 自定义可执行路径、异常退出的有限次退避重启
 * 因此子进程生命周期在此自管，客户端与协议交互全部走官方 SDK。
 *
 * 安全约束（对应 Plan.md 8.x / AGENT.md 5.1）：
 * - 仅监听 127.0.0.1，随机空闲端口
 * - 启动时生成高熵口令，仅保存在进程内存
 * - 独立 OpenCode 数据目录，避免与管理员个人会话混用
 * - 进程异常退出做有限次数退避重启
 * - 健康检查发现不兼容版本时禁用（固定并记录经过验证的版本）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { config, resSrcDir } from './config';
import { issueToken } from './auth';
import { logger } from './logger';

const OPENCODE_HEALTH_RETRIES = 60;
const OPENCODE_HEALTH_INTERVAL_MS = 500;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 2000;

/**
 * `/global/health` 响应契约。
 * SDK 1.18 生成的客户端没有 `global.health` 方法（Global 只暴露 event），
 * 健康检查只能直连该端点；AGENT.md 5.1 亦明确「启动后轮询 /global/health」。
 * 版本升级时以固定版本的 `/doc` OpenAPI 快照做契约测试兜底。
 */
interface GlobalHealth {
  healthy: boolean;
  version: string;
}

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

/**
 * 定位权限请求的发起会话（导出供测试）：
 * 审核/调试会话与主会话不同，回复必须回到发起会话，否则该会话会一直阻塞等待授权。
 * 从 opencode 待处理权限列表按 id 定位；权限已消失/列表为空时退回 fallbackSessionId。
 */
export function resolvePermissionTarget(
  pending: Array<Record<string, unknown>>,
  permissionId: string,
  fallbackSessionId: string,
): { sessionId: string; tool: string } {
  const perm = pending.find((p) => p.id === permissionId);
  return {
    sessionId: String(perm?.sessionID ?? '') || fallbackSessionId,
    tool: String(perm?.permission ?? ''),
  };
}

export interface ProviderOption {
  provider_id: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

/**
 * 归一化 opencode `/config/providers` 返回 → 前端 options.providers（导出供测试）。
 *
 * opencode Provider 结构：{ id, name, models: { [modelID]: Model } }——
 * - models 是「模型 ID → Model」的对象字典，不是数组（用 Array.isArray 判断恒为 false，
 *   会把所有模型的列表解析成空，前端表现为「无法获取模型」）
 * - Provider / Model 的展示字段是 name，没有 label
 */
export function normalizeProviders(
  providerList: Array<Record<string, unknown>>,
): ProviderOption[] {
  return providerList
    .map((p) => ({
      provider_id: String(p.id ?? ''),
      label: String(p.label ?? p.name ?? p.id ?? ''),
      models: Object.entries((p.models as Record<string, unknown>) ?? {}).map(([modelId, raw]) => {
        const m = (raw ?? {}) as Record<string, unknown>;
        const id = String(m.id ?? modelId);
        return {
          id,
          label: String(m.name ?? m.label ?? id),
        };
      }),
    }))
    .filter((p) => p.provider_id);
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
  private parentExitHandler: (() => void) | null = null;

  /**
   * 注册进程级兜底：无论父进程正常退出、崩溃还是被 bun --watch 热重载，
   * 都确保 opencode 子进程被终止，避免残留实例继续占用共享数据目录
   *（残留实例会吃掉 SSE 事件——权限/问题窗口收不到就是这种错位的表现）。
   * SIGKILL 无法捕获（进程直接被终结时不触发 'exit'），其余退出路径均覆盖。
   */
  private ensureParentExitCleanup() {
    if (this.parentExitHandler) return;
    this.parentExitHandler = () => {
      if (this.process && !this.process.killed) {
        try {
          this.process.kill('SIGKILL');
        } catch {
          // 进程可能已退出
        }
      }
    };
    process.on('exit', this.parentExitHandler);
  }

  getStatus(): OpenCodeStatus {
    return { ...this.status };
  }

  /** 获取 SDK 客户端；未就绪时抛出明确错误 */
  getClient(): OpencodeClient {
    if (!this.client || !this.status.available) {
      throw new Error(this.status.error ?? 'OpenCode 服务不可用，请检查后端诊断信息');
    }
    return this.client;
  }

  /**
   * 回答 question 请求（`POST /question/:requestID/reply`）。
   *
   * opencode 的 question 工具是挂起式的：模型调用后等待用户回答，只有通过该端点
   * 回传 `{ answers: string[][] }`（每个问题一个数组，元素为选项 label）才会唤醒模型。
   * SDK 1.18 未生成 question 客户端方法（types.gen 无 question 相关类型），因此复用
   * SDK 底层 client 的 post（同一套 baseUrl / Authorization / 错误包装），不另起 fetch。
   */
  async questionReply(requestID: string, answers: string[][], directory: string): Promise<void> {
    const raw = this.getClient() as unknown as {
      _client: {
        post(options: {
          url: string;
          query?: { directory?: string };
          body?: unknown;
          throwOnError?: boolean;
        }): Promise<unknown>;
      };
    };
    await raw._client.post({
      url: `/question/${requestID}/reply`,
      query: { directory },
      body: { answers },
      throwOnError: true,
    });
  }

  /** 拒绝 question 请求（`POST /question/:requestID/reject`），模型继续但不采纳回答 */
  async questionReject(requestID: string, directory: string): Promise<void> {
    const raw = this.getClient() as unknown as {
      _client: {
        post(options: {
          url: string;
          query?: { directory?: string };
          throwOnError?: boolean;
        }): Promise<unknown>;
      };
    };
    await raw._client.post({
      url: `/question/${requestID}/reject`,
      query: { directory },
      throwOnError: true,
    });
  }

  /**
   * 列出当前 opencode 实例所有待处理权限请求（`GET /permission`）。
   * SDK 1.18 未生成 permission API，复用 SDK 底层 client 的 get。
   * 用途：SSE 事件丢失/断线重连后，前端可主动拉取补出权限弹窗
   *（opencode 的 pending 权限在进程内存，只要 opencode 实例未重启就仍可恢复）。
   */
  async listPendingPermissions(directory?: string): Promise<Array<Record<string, unknown>>> {
    const raw = this.getClient() as unknown as {
      _client: {
        get(options: {
          url: string;
          query?: { directory?: string };
          throwOnError?: boolean;
        }): Promise<{ data?: unknown }>;
      };
    };
    const res = await raw._client.get({
      url: '/permission',
      ...(directory ? { query: { directory } } : {}),
      throwOnError: true,
    });
    const data = res?.data;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
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

  /**
   * 把 Studio 测试工具插件同步到隔离配置目录的插件目录（AGENT.md 3.5）：
   * opencode 全局插件目录 = <opencode data>/config/opencode/plugins/，
   * 目录内文件在启动时自动加载（ConfigPlugin.load 扫描 {plugin,plugins}/*.{ts,js}）。
   *
   * 插件源码位于 server/plugins/，用 Bun.build 打包为自包含 JS（内联
   * @opencode-ai/plugin 与 zod），避免运行时依赖 node_modules 解析。
   */
  private async syncPlugins(): Promise<void> {
    try {
      const pluginDir = join(config.opencode.data_dir, 'config', 'opencode', 'plugins');
      const source = join(resSrcDir(), '..', 'plugins', 'unibot-tools.ts');
      if (!existsSync(source)) {
        logger.warn('opencode', '未找到测试工具插件源码，跳过插件注册', { source });
        return;
      }
      mkdirSync(pluginDir, { recursive: true });
      // 清理旧产物后重新打包，保证与当前源码一致（Bun.build 不覆盖同路径产物会报错）
      for (const name of readdirSync(pluginDir)) {
        if (name.startsWith('unibot-tools')) rmSync(join(pluginDir, name), { force: true });
      }
      const out = await Bun.build({
        entrypoints: [source],
        outdir: pluginDir,
        naming: 'unibot-tools.js',
        target: 'bun',
        format: 'esm',
        minify: false,
        sourcemap: 'none',
        external: [],
      });
      if (!out.success) {
        logger.error('opencode', '测试工具插件打包失败，测试工具将不可用', {
          logs: out.logs.map((l) => l.message),
        });
        return;
      }
      logger.info('opencode', '测试工具插件已注册', {
        plugin: join(pluginDir, 'unibot-tools.js'),
        size: statSync(join(pluginDir, 'unibot-tools.js')).size,
      });
    } catch (e) {
      logger.error('opencode', '同步测试工具插件失败，测试工具将不可用', {
        error: (e as Error).message,
      });
    }
  }

  /**
   * 注入 LLM 超时配置到隔离配置目录（AGENT.md 3.5 需求）：
   * 思考模型长时间无输出时，opencode 默认的 chunkTimeout（30s）会提前掐断请求。
   * 在 <opencode data>/config/opencode/opencode.jsonc 写入常见 provider 的
   * options.timeout / options.chunkTimeout（只补未显式配置的项，优先保留用户配置）。
   */
  private syncTimeoutConfig(): void {
    try {
      const configDir = join(config.opencode.data_dir, 'config', 'opencode');
      mkdirSync(configDir, { recursive: true });
      const file = join(configDir, 'opencode.jsonc');
      let cfg: Record<string, unknown> = { $schema: 'https://opencode.ai/config.json' };
      try {
        const text = existsSync(file) ? readFileSync(file, 'utf-8') : '';
        const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (parsed && typeof parsed === 'object') cfg = parsed;
      } catch {
        // 配置损坏则从默认开始
      }
      const provider = (cfg.provider as Record<string, unknown>) ?? {};
      const timeout = config.opencode.timeout_ms;
      const chunkTimeout = config.opencode.chunk_timeout_ms;
      for (const id of ['anthropic', 'openai', 'deepseek', 'openrouter', 'gemini', 'azure', 'github-copilot']) {
        const p = (provider[id] as Record<string, unknown>) ?? {};
        const options = (p.options as Record<string, unknown>) ?? {};
        // 用户已显式配置的超时以用户为准；未配置则注入平台默认（调大）
        if (options.timeout === undefined) options.timeout = timeout;
        if (options.chunkTimeout === undefined) options.chunkTimeout = chunkTimeout;
        p.options = options;
        provider[id] = p;
      }
      cfg.provider = provider;
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
      logger.info('opencode', `已注入 LLM 超时配置（timeout=${timeout}ms, chunkTimeout=${chunkTimeout}ms）`);
    } catch (e) {
      logger.error('opencode', '注入 LLM 超时配置失败', { error: (e as Error).message });
    }
  }

  private async launch() {
    this.ensureParentExitCleanup();
    const bin = config.opencode.bin;
    // 获取随机空闲端口
    this.port = await getFreePort();
    // 默认随机高熵口令；可用环境变量覆盖（便于调试/测试直连 opencode API）
    this.password = process.env.OPENCODE_SERVER_PASSWORD ?? randomBytes(24).toString('base64url');
    // 独立数据/配置目录（通过 XDG 变量隔离，不依赖固定 CLI 参数）
    const dataDir = config.opencode.data_dir;
    // 注入 LLM 超时配置（必须在 opencode 启动前完成，opencode 启动时读取）
    this.syncTimeoutConfig();
    // 注册测试工具插件（必须在 opencode 启动前完成：插件在启动时扫描加载）
    await this.syncPlugins();

    const args = [
      'serve',
      '--hostname', '127.0.0.1',
      '--port', String(this.port),
    ];
    // 插件回调 Studio API 所需的连接信息（AGENT.md 3.5：插件只做参数转发，操作由后端执行）
    const pluginApiBase = `http://127.0.0.1:${config.port}`;
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      OPENCODE_SERVER_PASSWORD: this.password,
      XDG_DATA_HOME: join(dataDir, 'data'),
      XDG_CONFIG_HOME: join(dataDir, 'config'),
      XDG_CACHE_HOME: join(dataDir, 'cache'),
      UNIBOT_STUDIO_API_URL: pluginApiBase,
      UNIBOT_STUDIO_API_TOKEN: issueToken(365 * 24 * 60 * 60 * 1000),
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

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
  }

  /**
   * 直连 `/global/health`（见 GlobalHealth 注释）。
   * 不经过 SDK 客户端：健康检查发生在客户端创建之前/进程重启期间。
   */
  private async fetchHealth(): Promise<GlobalHealth> {
    const res = await fetch(`${this.url}/global/health`, {
      headers: { Authorization: this.authHeader() },
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) throw new Error(`健康检查失败 (HTTP ${res.status})`);
    return (await res.json()) as GlobalHealth;
  }

  /**
   * 版本兼容检查：固定并记录经过验证的版本（AGENT.md 5.1），
   * 比较主/次版本号；不兼容时禁用工坊并给出明确诊断。
   */
  private versionCompatible(actual: string | null | undefined): boolean {
    if (!actual) return false;
    const required = config.opencode.version;
    const req = required.match(/^(\d+)\.(\d+)/);
    const act = actual.match(/^(\d+)\.(\d+)/);
    return Boolean(req && act && req[1] === act[1] && req[2] === act[2]);
  }

  private async waitHealthy(): Promise<void> {
    for (let i = 0; i < OPENCODE_HEALTH_RETRIES; i++) {
      if (this.stopping) return;
      try {
        const health = await this.fetchHealth();
        if (!this.versionCompatible(health.version)) {
          this.status.available = false;
          this.status.error =
            `OpenCode 版本不兼容：需要 ${config.opencode.version}（${config.opencode.version.split('.')[0]}.${config.opencode.version.split('.')[1]}.x），` +
            `当前 ${health.version}。请升级 opencode 或在配置中调整 OPENCODE_BIN。`;
          logger.error('opencode', 'OpenCode 版本不兼容，禁用工坊', {
            required: config.opencode.version,
            actual: health.version,
          });
          return;
        }
        // 健康检查通过：按 SDK 文档创建客户端（throwOnError 见文件头注释）
        this.status.available = true;
        this.status.version = health.version;
        this.status.url = this.url;
        this.status.error = null;
        this.client = createOpencodeClient({
          baseUrl: this.url!,
          headers: { Authorization: this.authHeader() },
          throwOnError: true,
        });
        logger.info('opencode', '健康检查通过', { version: health.version, url: this.url });
        return;
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
