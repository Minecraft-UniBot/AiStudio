/**
 * 平台配置：数据目录、UniBot 目录、OpenCode 网关参数、功能开关与认证。
 *
 * 配置优先级：环境变量 > 配置文件（config/studio.json）> 默认值。
 * 口令优先级：环境变量 UNIBOT_STUDIO_PASSWORD > 配置文件 > 首次启动自动生成。
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { StudioConfig } from './types';

const DEFAULT_DATA_DIR = join(homedir(), '.unibot-studio');

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
    extensions_dir: join(detectUnibotDir(), 'Extensions'),
    host: process.env.UNIBOT_STUDIO_HOST ?? '127.0.0.1',
    port: Number(process.env.UNIBOT_STUDIO_PORT ?? 9876),
    static_dir: process.env.UNIBOT_STUDIO_STATIC_DIR ?? '',
    opencode: {
      bin: process.env.OPENCODE_BIN ?? 'opencode',
      // 与 server/package.json 的 @opencode-ai/sdk 版本一致；桌面客户端随包内置该版本二进制
      version: '1.18.18',
      data_dir: join(dataDir, 'opencode'),
    },
    unibot_env: {
      repo_owner: process.env.UNIBOT_REPO_OWNER ?? 'MineJPGcraft',
      repo_name: process.env.UNIBOT_REPO_NAME ?? 'UniBot',
      release_asset: 'UniBot.zip',
      fallback_tag: 'v1.0.1',
      test_dir: join(dataDir, 'unibot'),
    },
    features: {
      review: true,
      mc_test_environment: false,
      market_publish: false,
      git_integration: false,
    },
    defaults: {
      agent: 'build',
      max_review_rounds: 3,
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

/** 持久化配置（保存时保留自动生成的口令） */
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
  return merged;
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
  const docsDir = join(import.meta.dir, '..', 'prompts', 'docs');
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
  return join(import.meta.dir, '..', 'validation', 'validate_extension.py');
}

/** 初始化平台数据目录结构 */
export function ensureDataDirs() {
  for (const dir of [
    join(config.data_dir, 'drafts'),
    join(config.data_dir, 'logs'),
    join(config.data_dir, 'opencode'),
    join(config.data_dir, 'config'),
    config.unibot_env.test_dir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
