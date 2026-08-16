/**
 * UniBot 测试环境管理：从 GitHub Releases 自动拉取最新 UniBot 源码，解压到平台数据目录
 * （<data_dir>/unibot/），并用 uv 同步依赖（.venv），供扩展校验流水线（validation.ts）
 * 在隔离环境里执行测试。
 *
 * 设计（对应「不需要每个草稿都配一套 UniBot 源码和环境，放在工作目录即可」）：
 * - 全平台共享一份环境（config.unibot_env.test_dir），不随草稿复制
 * - 幂等：环境已就绪且未强制更新时直接返回，不重复下载
 * - 原子替换：新版本先下载解压到临时目录，uv sync 通过后再整体替换正式目录，失败不污染旧环境
 * - 并发锁：同一时刻只允许一个下载/同步任务
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { config } from './config';
import { assertDiskSpace } from './disk';
import { logger } from './logger';
import type { UnibotEnvStatus } from './types';

/** 内存中的运行状态（磁盘状态由 getUnibotEnvStatus 实时探测） */
const state: UnibotEnvStatus = {
  state: 'missing',
  path: config.unibot_env.test_dir,
  version: null,
  tag: null,
  venv_ready: false,
  error: null,
  updated_at: null,
};

/** 当前下载/同步任务（并发锁：同一时刻只允许一个） */
let current_task: Promise<UnibotEnvStatus> | null = null;

/** 环境元数据文件（记录来源 tag、版本与更新时间，供快速状态查询） */
function metaFile(): string {
  return join(config.unibot_env.test_dir, '.env-meta.json');
}

interface EnvMeta {
  tag: string | null;
  version: string | null;
  updated_at: string | null;
}

function readMeta(): EnvMeta {
  try {
    return JSON.parse(readFileSync(metaFile(), 'utf-8')) as EnvMeta;
  } catch {
    return { tag: null, version: null, updated_at: null };
  }
}

/** venv 内的 Python 可执行文件（uv 约定 .venv 目录） */
function pythonBin(root: string): string {
  return process.platform === 'win32'
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python');
}

/** 异步执行子进程，收集输出并支持超时（超时返回 code 124） */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeout_ms?: number } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd });
    let output = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, output });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', (error) => {
      output += `\n[spawn 失败] ${error.message}`;
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
    if (options.timeout_ms) {
      setTimeout(() => {
        child.kill('SIGKILL');
        finish(124);
      }, options.timeout_ms).unref();
    }
  });
}

/** 解析 release 下载地址：优先 GitHub API latest，失败回退固定 tag 地址 */
async function resolveReleaseUrl(): Promise<{ url: string; tag: string }> {
  const { repo_owner, repo_name, release_asset, fallback_tag } = config.unibot_env;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo_owner}/${repo_name}/releases/latest`,
      { headers: { 'User-Agent': 'unibot-extension-studio', Accept: 'application/vnd.github+json' } },
    );
    if (response.ok) {
      const data = (await response.json()) as {
        tag_name?: string;
        assets?: Array<{ name?: string; browser_download_url?: string }>;
      };
      const tag = data.tag_name ?? fallback_tag;
      const asset = (data.assets ?? []).find((item) => item.name === release_asset);
      if (asset?.browser_download_url) return { url: asset.browser_download_url, tag };
    }
  } catch {
    // API 受限（限流/离线）时回退固定地址
  }
  return {
    url: `https://github.com/${repo_owner}/${repo_name}/releases/download/${fallback_tag}/${release_asset}`,
    tag: fallback_tag,
  };
}

/** 下载文件到本地（重定向跟随，失败抛错） */
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, buffer);
}

/** 在解压目录中定位 UniBot 源码根（release zip 可能带一层顶层目录） */
function findUnibotRoot(extractDir: string): string {
  if (existsSync(join(extractDir, 'Bot.py'))) return extractDir;
  for (const entry of readdirSync(extractDir)) {
    const candidate = join(extractDir, entry);
    if (existsSync(join(candidate, 'Bot.py'))) return candidate;
  }
  throw new Error('解压内容中未找到 UniBot 源码（缺少 Bot.py）');
}

/** 从 pyproject.toml 读取源码版本 */
function readVersion(root: string): string | null {
  try {
    const pyproject = parseToml(readFileSync(join(root, 'pyproject.toml'), 'utf-8')) as {
      project?: { version?: string };
    };
    return pyproject.project?.version ?? null;
  } catch {
    return null;
  }
}

/** 执行完整的拉取任务：下载 → 解压 → uv sync → 原子替换正式目录 */
async function syncTask(): Promise<UnibotEnvStatus> {
  const { url, tag } = await resolveReleaseUrl();
  const root = config.unibot_env.test_dir;
  // 临时目录（staging + backup 均位于数据目录内，同一文件系统保证 rename 原子）
  const staging = join(config.data_dir, '.unibot-staging');
  const backup = join(config.data_dir, '.unibot-backup');
  assertDiskSpace(config.data_dir, '拉取 UniBot 测试环境');
  rmSync(staging, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    state.state = 'downloading';
    state.error = null;
    logger.info('unibot-env', '开始下载 UniBot 源码', { url, tag });
    const zipPath = join(staging, 'unibot.zip');
    await downloadFile(url, zipPath);

    state.state = 'installing';
    const extractDir = join(staging, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    const extractResult = await runProcess('unzip', ['-q', '-o', zipPath, '-d', extractDir]);
    if (extractResult.code !== 0) throw new Error(`解压失败：${extractResult.output.slice(-400)}`);
    const sourceRoot = findUnibotRoot(extractDir);
    // release 包不含用户配置：缺失时生成最小默认配置（模型字段均有默认值，空表即可），
    // 否则校验脚本导入 Scripts.Config 时会因缺少 Config.toml 直接崩溃
    const configToml = join(sourceRoot, 'Config.toml');
    if (!existsSync(configToml)) {
      writeFileSync(
        configToml,
        '# 由 Extension Studio 自动生成的最小配置（其余字段使用模型默认值）\n',
        'utf-8',
      );
    }

    // uv sync：dev 组（pytest/ruff）默认包含，webui 组补全 WebUI 相关依赖
    logger.info('unibot-env', '同步 UniBot 依赖（uv sync）', { root: sourceRoot });
    const syncResult = await runProcess('uv', ['sync', '--extra', 'webui'], {
      cwd: sourceRoot,
      timeout_ms: 15 * 60_000,
    });
    if (syncResult.code !== 0) throw new Error(`uv sync 失败：${syncResult.output.slice(-800)}`);

    const version = readVersion(sourceRoot);
    // 原子替换：旧环境挪到 backup，新环境 rename 上位，再清理 backup
    if (existsSync(root)) renameSync(root, backup);
    renameSync(sourceRoot, root);
    rmSync(backup, { recursive: true, force: true });
    writeFileSync(
      metaFile(),
      JSON.stringify({ tag, version, updated_at: new Date().toISOString() }, null, 2) + '\n',
      'utf-8',
    );

    state.state = 'ready';
    state.venv_ready = true;
    state.version = version;
    state.tag = tag;
    state.updated_at = new Date().toISOString();
    logger.info('unibot-env', 'UniBot 测试环境就绪', { path: root, tag, version });
  } catch (error) {
    state.state = 'error';
    state.error = (error as Error).message;
    logger.error('unibot-env', '拉取 UniBot 测试环境失败', { error: (error as Error).message });
  } finally {
    rmSync(staging, { recursive: true, force: true });
    // 安装失败时回滚：正式目录已被挪走但 backup 存在 → 恢复旧环境，避免环境丢失
    if (!existsSync(root) && existsSync(backup)) {
      renameSync(backup, root);
    } else {
      rmSync(backup, { recursive: true, force: true });
    }
  }
  return getUnibotEnvStatus();
}

/**
 * 确保测试环境就绪（幂等）。
 * - 已就绪且未强制更新：直接返回（不重复下载）
 * - 未就绪 / 强制更新：发起下载+安装，带并发锁
 */
export async function ensureUnibotEnv(force = false): Promise<UnibotEnvStatus> {
  const root = config.unibot_env.test_dir;
  const ready = existsSync(join(root, 'Bot.py')) && existsSync(pythonBin(root));
  if (!force && ready) {
    const meta = readMeta();
    state.state = 'ready';
    state.venv_ready = true;
    state.version = meta.version;
    state.tag = meta.tag;
    state.updated_at = meta.updated_at;
    state.error = null;
    return getUnibotEnvStatus();
  }
  if (current_task) return current_task;
  current_task = syncTask();
  try {
    return await current_task;
  } finally {
    current_task = null;
  }
}

/** 强制重新拉取最新版本 */
export function syncUnibotEnv(): Promise<UnibotEnvStatus> {
  return ensureUnibotEnv(true);
}

/** 查询当前状态（实时探测磁盘，运行中任务返回其进行状态） */
export function getUnibotEnvStatus(): UnibotEnvStatus {
  const root = config.unibot_env.test_dir;
  const ready = existsSync(join(root, 'Bot.py')) && existsSync(pythonBin(root));
  if (ready && state.state !== 'downloading' && state.state !== 'installing') {
    const meta = readMeta();
    return {
      ...state,
      state: 'ready',
      venv_ready: true,
      version: meta.version,
      tag: meta.tag,
      updated_at: meta.updated_at,
      error: null,
    };
  }
  return { ...state, venv_ready: existsSync(pythonBin(root)) };
}
