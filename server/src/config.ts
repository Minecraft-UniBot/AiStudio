/**
 * 平台配置：数据目录、UniBot 目录、OpenCode 网关参数、功能开关与认证。
 *
 * 配置优先级：环境变量 > 配置文件（config/studio.json）> 默认值。
 * 口令优先级：环境变量 UNIBOT_STUDIO_PASSWORD > 配置文件 > 首次启动自动生成。
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { StudioConfig } from './types';

const DEFAULT_DATA_DIR = join(homedir(), '.unibot-studio');

/**
 * 资源目录基准（模拟 server/src 目录）：
 * - 常规运行：本文件所在目录（server/src），prompts / skills / validation 位于其上一级
 * - 单文件可执行版：启动器把内置资源解压到数据目录后，通过 UNIBOT_STUDIO_RES_DIR
 *   指向解压出的 src 基准目录，供重定位 prompts / skills / validation / docs。
 */
export function resSrcDir(): string {
  return process.env.UNIBOT_STUDIO_RES_DIR || import.meta.dir;
}

/** 从仓库根目录探测 UniBot 目录（支持被软链或拷贝到任意位置） */
function detectUnibotDir(): string {
  // 1. 环境变量显式指定
  if (process.env.UNIBOT_DIR) return process.env.UNIBOT_DIR;
  // 2. 从当前文件位置向上找仓库（Studio/server/src -> Studio/server -> Studio -> 仓库根）
  let dir = import.meta.dir;
  for (let i = 0; i < 6; i++) {
    const parent = dirname(dir);
    if (parent === dir) break; // 已到文件系统根（跨平台：POSIX '/' 与 Windows 'C:\' 均在此停止）
    dir = parent;
    if (existsSync(join(dir, 'UniBot', 'Bot.py'))) return join(dir, 'UniBot');
  }
  // 3. 默认：与 Studio 平级的 UniBot
  return join(process.cwd(), 'UniBot');
}

function loadConfig(): StudioConfig {
  const dataDir = process.env.UNIBOT_STUDIO_DATA_DIR ?? DEFAULT_DATA_DIR;
  const configFile = join(dataDir, 'config', 'studio.json');

  const base: StudioConfig = {
    data_dir: dataDir,
    unibot_dir: detectUnibotDir(),
    unibot_configured: false,
    extensions_dir: join(detectUnibotDir(), 'Extensions'),
    host: process.env.UNIBOT_STUDIO_HOST ?? '127.0.0.1',
    port: Number(process.env.UNIBOT_STUDIO_PORT ?? 9876),
    static_dir: process.env.UNIBOT_STUDIO_STATIC_DIR ?? '',
    opencode: {
      bin: process.env.OPENCODE_BIN ?? 'opencode',
      // 与 server/package.json 的 @opencode-ai/sdk 版本一致；
      // 单文件版首次启动时按此版本自动下载（见 opencode_download.ts）
      version: '1.18.18',
      data_dir: join(dataDir, 'opencode'),
      // LLM 请求超时（毫秒）：注入 opencode provider options.timeout / chunkTimeout。
      // 思考模型长时间无输出时默认 chunkTimeout（30s）会提前掐断，这里统一调大。
      timeout_ms: 900_000,       // 整次请求超时（opencode 默认 300s）
      chunk_timeout_ms: 300_000, // 流式块间隔超时（opencode 默认 30s）
    },
    unibot_env: {
      repo_owner: process.env.UNIBOT_REPO_OWNER ?? 'MineJPGcraft',
      repo_name: process.env.UNIBOT_REPO_NAME ?? 'UniBot',
      release_asset: 'UniBot.zip',
      fallback_tag: 'v1.0.1',
      test_dir: join(dataDir, 'unibot'),
    },
    features: {
      test_tools: true,
      mc_test_environment: false,
      market_publish: false,
      git_integration: false,
    },
    defaults: {
      agent: 'build',
    },
    auth: { password: '', token_secret: '' },
  };

  let disk: Partial<StudioConfig> = {};
  if (existsSync(configFile)) {
    try {
      disk = JSON.parse(readFileSync(configFile, 'utf-8')) as Partial<StudioConfig>;
    } catch {
      disk = {};
    }
  }

  const merged: StudioConfig = {
    ...base,
    ...disk,
    opencode: { ...base.opencode, ...(disk.opencode ?? {}) },
    unibot_env: { ...base.unibot_env, ...(disk.unibot_env ?? {}) },
    features: { ...base.features, ...(disk.features ?? {}) },
    defaults: { ...base.defaults, ...(disk.defaults ?? {}) },
    auth: { ...base.auth, ...(disk.auth ?? {}) },
  };

  // 环境变量优先级高于配置文件（文件头注释与 README「配置」表约定，单文件版依赖此行为）：
  // 磁盘配置（含首次启动自动生成的 password/token 写盘时落下的整份配置）不能覆盖 env。
  if (process.env.UNIBOT_STUDIO_HOST) merged.host = process.env.UNIBOT_STUDIO_HOST;
  if (process.env.UNIBOT_STUDIO_PORT) merged.port = Number(process.env.UNIBOT_STUDIO_PORT);
  if (process.env.UNIBOT_STUDIO_DATA_DIR) merged.data_dir = process.env.UNIBOT_STUDIO_DATA_DIR;
  if (process.env.UNIBOT_STUDIO_STATIC_DIR) merged.static_dir = process.env.UNIBOT_STUDIO_STATIC_DIR;
  if (process.env.OPENCODE_BIN) merged.opencode.bin = process.env.OPENCODE_BIN;
  if (process.env.UNIBOT_DIR) {
    merged.unibot_dir = process.env.UNIBOT_DIR;
    merged.extensions_dir = join(process.env.UNIBOT_DIR, 'Extensions');
  }

  // 口令：环境变量 > 已存配置 > 自动生成
  if (process.env.UNIBOT_STUDIO_PASSWORD) {
    merged.auth.password = process.env.UNIBOT_STUDIO_PASSWORD;
  } else if (!merged.auth.password) {
    merged.auth.password = randomBytes(9).toString('base64url');
    writeConfig(merged, configFile);
  }
  // token 签名密钥：自动生成并持久化（后端重启后已签发 token 仍可验证）
  if (!merged.auth.token_secret) {
    merged.auth.token_secret = randomBytes(32).toString('base64url');
    writeConfig(merged, configFile);
  }
  return merged;
}

function writeConfig(config: StudioConfig, configFile: string) {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * 持久化配置（保存时保留自动生成的口令）。
 *
 * 重要：合并后回写到内存中的 `config`（Object.assign），使运行时各模块
 * （publishing.ts / drafts.ts / registry.ts）立即读到新值，无需重启进程。
 * 旧实现只落盘不回写内存，导致 /settings 改完不生效直到下次重启。
 */
export function saveConfig(patch: Partial<StudioConfig>): StudioConfig {
  const merged: StudioConfig = {
    ...config,
    ...patch,
    opencode: { ...config.opencode, ...(patch.opencode ?? {}) },
    unibot_env: { ...config.unibot_env, ...(patch.unibot_env ?? {}) },
    features: { ...config.features, ...(patch.features ?? {}) },
    defaults: { ...config.defaults, ...(patch.defaults ?? {}) },
    auth: { ...config.auth, ...(patch.auth ?? {}) },
  };
  writeConfig(merged, join(config.data_dir, 'config', 'studio.json'));
  // 同步内存配置：逐字段回写，避免 import 拿到的旧引用读到过期值
  Object.assign(config, merged);
  return merged;
}

/**
 * 设置并校验 UniBot 目录。
 *
 * 校验：目录存在，且看起来像 UniBot 仓库根（含 Bot.py 或 Extensions/ 之一），
 * 避免用户随手填一个不存在/非 UniBot 的路径导致发布落到错误位置。
 * 通过则更新 unibot_dir / extensions_dir 并标记 unibot_configured=true，立即生效并落盘。
 *
 * @returns 校验失败时返回 { ok:false, error }；成功返回 { ok:true }
 */
export function setUnibotDir(dir: string): { ok: true } | { ok: false; error: string } {
  const trimmed = (dir ?? '').trim();
  if (!trimmed) return { ok: false, error: 'UniBot 目录不能为空' };
  const abs = resolve(trimmed);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { ok: false, error: `目录不存在：${abs}` };
  }
  // 识别 UniBot 仓库根：Bot.py（源码根）或 Extensions/（运行根）至少有一个
  const looksLikeUnibot = existsSync(join(abs, 'Bot.py')) || existsSync(join(abs, 'Extensions'));
  if (!looksLikeUnibot) {
    return {
      ok: false,
      error: '该目录看起来不像 UniBot：未找到 Bot.py 或 Extensions 目录',
    };
  }
  saveConfig({
    unibot_dir: abs,
    extensions_dir: join(abs, 'Extensions'),
    unibot_configured: true,
  });
  // 发布目录可能不存在（全新 UniBot），创建一下避免首次发布报错
  mkdirSync(join(abs, 'Extensions'), { recursive: true });
  return { ok: true };
}

export const config: StudioConfig = loadConfig();

/**
 * 本地文档只读白名单（注入到 OpenCode 会话的安全约束）。
 *
 * 文档以副本形式存放在 Studio 内（server/prompts/docs/，由仓库脚本从
 * UniBot/Docs 与 UniBot/AGENT.md 同步），不依赖 unibot_dir 的绝对路径，
 * 避免 AI 因「目录外禁止读取」而去 web_fetch 搜索本项目内容。
 * 路径基于本文件位置解析（import.meta.dir -> server/prompts/docs），仅可读取、禁止修改。
 */

/** 文档白名单绝对路径数组（供安全约束文本与权限自动放行共用） */
export function docsAllowlistPaths(): string[] {
  const docsDir = join(resSrcDir(), '..', 'prompts', 'docs');
  const files = [
    '开发插件.md',
    '扩展系统.md',
    '配置说明.md',
    '上传市场.md',
    '接口文档.md',
    '编码规范.md',
  ];
  return files.map((f) => join(docsDir, f));
}

/** 文档白名单格式化文本（注入到 OpenCode 会话的安全约束） */
export function docsAllowlist(): string {
  return docsAllowlistPaths().map((p) => `  - ${p}`).join('\n');
}

/**
 * 扩展市场注册表只读白名单（注入到 OpenCode 会话的安全约束）。
 * 市场注册表是独立仓库（MineJPGcraft/UniBot.Market），位于工作区根 Market/extensions.json。
 * 仅当文件真实存在时才纳入白名单：CI 由工作流检出到 Market/，独立部署/全新克隆缺失时
 * 自动省略，避免安全约束指向不存在的文件、提示词注入失效的市场路径。
 */
export function marketAllowlistPaths(): string[] {
  const repoRoot = join(import.meta.dir, '..', '..', '..');
  const registry = join(repoRoot, 'Market', 'extensions.json');
  return existsSync(registry) ? [registry] : [];
}

/** 市场注册表路径（供 planning/scaffold 提示词引用；注册表缺失时为空字符串，占位符自动省略） */
export function marketRegistryPath(): string {
  return marketAllowlistPaths()[0] ?? '';
}

/** 市场注册表格式化文本（注入安全约束） */
export function marketAllowlist(): string {
  return marketAllowlistPaths().map((p) => `  - ${p}`).join('\n');
}

/**
 * UniBot 测试环境（config.unibot_env.test_dir）的 venv Python 可执行路径。
 * 供编码/调试阶段 AI 在隔离测试环境里运行校验脚本验证扩展（见 tools.ts 的 unibot_test）。
 */
export function unibotEnvPython(): string {
  return join(
    config.unibot_env.test_dir,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
}

/** UniBot 校验脚本绝对路径（server/validation/validate_extension.py） */
export function validationScriptPath(): string {
  return join(resSrcDir(), '..', 'validation', 'validate_extension.py');
}

/** 模板预览渲染脚本绝对路径（server/validation/preview_template.py） */
export function previewScriptPath(): string {
  return join(resSrcDir(), '..', 'validation', 'preview_template.py');
}

/** 初始化平台数据目录结构 */
export function ensureDataDirs() {
  for (const dir of [
    join(config.data_dir, 'drafts'),
    join(config.data_dir, 'logs'),
    join(config.data_dir, 'opencode'),
    join(config.data_dir, 'config'),
    join(config.data_dir, 'templates'),
    config.unibot_env.test_dir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
