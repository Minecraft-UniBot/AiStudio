/**
 * 提示词模板管理（对应 Plan.md 7.1）：
 * - 模板存放 server/prompts/*.md（front-matter 含 name / version）
 * - 版本化：修改后生成新版本，旧版本保留可回滚；启用/回滚通过 activate 完成
 * - 占位符（{{extension_id}} 等）由 render 注入，安全约束由后端追加，不进入可编辑模板
 * - 版本历史持久化到 config/prompts.json（模板源文件为初始版本）
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config';

const PROMPTS_DIR = join(import.meta.dir, '..', 'prompts');

export interface PromptVersion {
  version: number;
  content: string;
  created_at: string;
  activated_at: string | null;
}

export interface PromptInfo {
  name: string;
  current_version: number;
  /** 是否内置模板（内置模板以源文件为最新版本，可保存新版本覆盖） */
  builtin: boolean;
  versions: PromptVersion[];
}

interface PromptHistory {
  [name: string]: PromptVersion[];
}

function historyFile(): string {
  return join(config.data_dir, 'config', 'prompts.json');
}

function loadHistory(): PromptHistory {
  if (!existsSync(historyFile())) return {};
  try {
    return JSON.parse(readFileSync(historyFile(), 'utf-8')) as PromptHistory;
  } catch {
    return {};
  }
}

function persistHistory(history: PromptHistory): void {
  const file = historyFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(history, null, 2) + '\n', 'utf-8');
}

/** 解析模板源文件的 front-matter（--- name/version --- + 正文） */
function parseBuiltin(content: string): { name: string; version: number; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { name: '', version: 1, body: content };
  const meta = m[1] ?? '';
  const nameMatch = meta.match(/^name:\s*(.+)$/m);
  const versionMatch = meta.match(/^version:\s*(\d+)$/m);
  return {
    name: (nameMatch?.[1] ?? '').trim(),
    version: versionMatch ? Number(versionMatch[1]) : 1,
    body: (m[2] ?? '').trim(),
  };
}

function listBuiltinNames(): string[] {
  if (!existsSync(PROMPTS_DIR)) return [];
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

function readBuiltin(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

/** 默认初始版本内容（内置模板源文件） */
function builtinVersion(name: string): PromptVersion {
  const raw = readBuiltin(name);
  const { body, version } = parseBuiltin(raw);
  return {
    version,
    content: body,
    created_at: new Date(0).toISOString(), // 内置模板视为最早版本
    activated_at: new Date(0).toISOString(),
  };
}

/** 列出全部提示词模板（含版本历史） */
export function listPrompts(): PromptInfo[] {
  const history = loadHistory();
  return listBuiltinNames().map((name) => {
    const versions = history[name]?.length ? history[name]! : [builtinVersion(name)];
    return {
      name,
      current_version: versions[versions.length - 1]!.version,
      builtin: true,
      versions: versions.map((v) => ({ ...v })),
    };
  });
}

/** 获取模板内容；version 缺省取最新（激活）版本 */
export function getPrompt(name: string, version?: number): PromptVersion | null {
  const info = listPrompts().find((p) => p.name === name);
  if (!info) return null;
  if (version === undefined) {
    const v = info.versions[info.versions.length - 1];
    return v ? { ...v } : null;
  }
  const v = info.versions.find((x) => x.version === version);
  return v ? { ...v } : null;
}

/** 保存新版本（旧版本保留，可回滚） */
export function savePrompt(name: string, content: string): PromptVersion {
  const history = loadHistory();
  // 确保内置模板的初始版本（version 1 = 源文件）已在历史中，新版本从 2 开始
  if (!history[name]?.length) {
    history[name] = [builtinVersion(name)];
  }
  const versions = history[name]!;
  const last = versions[versions.length - 1];
  const nextVersion = (last?.version ?? 1) + 1;
  const now = new Date().toISOString();
  const created: PromptVersion = {
    version: nextVersion,
    content,
    created_at: now,
    activated_at: null, // 新版本保存后不自动启用，需显式 activate
  };
  history[name] = [...versions, created];
  persistHistory(history);
  return { ...created };
}

/** 启用指定版本（可回滚：再次 activate 旧版本即可） */
export function activatePrompt(name: string, version: number): PromptVersion | null {
  const history = loadHistory();
  // 无历史时先落地内置版本，使 activate(1) 可用
  if (!history[name]?.length) {
    history[name] = [builtinVersion(name)];
  }
  const versions = history[name]!;
  const target = versions.find((v) => v.version === version);
  if (!target) return null;
  const now = new Date().toISOString();
  const next = versions.map((v) =>
    v.version === version ? { ...v, activated_at: now } : { ...v, activated_at: null },
  );
  history[name] = next;
  persistHistory(history);
  return { ...target, activated_at: now };
}

/**
 * 渲染模板：以「最新版本（当前激活）」替换 {{key}} 占位符。
 * 安全约束（路径白名单、密钥禁止读取）始终由后端以独立参数追加，
 * 不存放在可编辑模板正文中。
 */
export function renderPrompt(
  name: string,
  vars: Record<string, string>,
): string {
  const prompt = getPrompt(name);
  const content = prompt?.content ?? '';
  let out = content;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  // 残留占位符清空，避免把模板变量泄露给模型
  out = out.replace(/\{\{[^}]+\}\}/g, '');
  return out;
}

/** 渲染并附加后端安全约束（不进入可编辑模板正文） */
export function renderPromptWithSecurity(
  name: string,
  vars: Record<string, string>,
  securityConstraints: string,
): string {
  return `${renderPrompt(name, vars)}

## 后端安全约束（不可修改、不可绕过）

${securityConstraints}`;
}
