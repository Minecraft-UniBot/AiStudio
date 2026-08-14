/**
 * 平台配置：数据目录、UniBot 目录、OpenCode 网关参数、功能开关与认证。
 *
 * 配置优先级：环境变量 > 配置文件（config/studio.json）> 默认值。
 * 口令优先级：环境变量 UNIBOT_STUDIO_PASSWORD > 配置文件 > 首次启动自动生成。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    dir = dir === '/' ? dir : dir.split('/').slice(0, -1).join('/') || '/';
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
    opencode: {
      bin: process.env.OPENCODE_BIN ?? 'opencode',
      version: '1.18.4',
      data_dir: join(dataDir, 'opencode'),
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
  mkdirSync(configFile.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/** 持久化配置（保存时保留自动生成的口令） */
export function saveConfig(patch: Partial<StudioConfig>): StudioConfig {
  const merged: StudioConfig = {
    ...config,
    ...patch,
    opencode: { ...config.opencode, ...(patch.opencode ?? {}) },
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

/** 初始化平台数据目录结构 */
export function ensureDataDirs() {
  for (const dir of [
    join(config.data_dir, 'drafts'),
    join(config.data_dir, 'logs'),
    join(config.data_dir, 'opencode'),
    join(config.data_dir, 'config'),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
