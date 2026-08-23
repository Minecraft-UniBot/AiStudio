/**
 * 草稿服务：草稿 CRUD、脚手架生成、路径安全解析与文件摘要。
 *
 * 安全约束（对应 Plan.md 5.2）：
 * - 所有路径使用 resolve() 获取规范路径并校验位于草稿 workspace 内
 * - 拒绝符号链接、`..`、绝对路径
 * - 扩展 ID 为 PascalCase，创建后不可修改
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { config } from '../core/config';
import { assertDiskSpace } from '../core/disk';
import { logger } from '../core/logger';
import { cloneTemplateSource, getTemplate } from './templates';
import type { DraftMeta, ExtensionType, McServerInfo } from '../core/types';

const MANIFEST_SCAFFOLD = `[manifest]
schema_version = 1

[extension]
id = "{{extension_id}}"
name = "{{name}}"
version = "0.1.0"
author = "Studio"
description = "{{description}}"
types = [{{types}}]

[compatibility]
unibot = ">=0.0.5"

[dependencies]
extensions = []
python = []
`;

const INIT_SCAFFOLD = `"""{{name}} 扩展入口。"""

from Scripts.Extensions import Extension

extension = Extension()
`;

const TEST_SCAFFOLD = `"""{{name}} 扩展基础测试。"""


def test_placeholder() -> None:
    """占位测试，AI 生成的实现会补充真实场景。"""
    assert True
`;

export class DraftError extends Error {
  constructor(
    message: string,
    public code: string = 'DRAFT_ERROR',
  ) {
    super(message);
  }
}

/** 校验扩展 ID：PascalCase、字母数字、不得与现有扩展/草稿冲突 */
export function validateExtensionId(id: string, drafts: DraftMeta[]): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(id)) {
    throw new DraftError('扩展 ID 必须为 PascalCase（如 WeatherExt），且只能包含字母和数字', 'INVALID_ID');
  }
  if (drafts.some((d) => d.extension_id === id && d.status !== 'published')) {
    throw new DraftError(`扩展 ID "${id}" 已存在草稿`, 'ID_CONFLICT');
  }
  if (existsSync(join(config.extensions_dir, id))) {
    throw new DraftError(`扩展 ID "${id}" 已存在于 UniBot 扩展目录`, 'ID_CONFLICT');
  }
  return id;
}

/** 草稿根目录 */
export function draftDir(draftId: string): string {
  return join(config.data_dir, 'drafts', draftId);
}

/** 草稿工作区（AI 可操作的最上层目录） */
export function draftWorkspace(draftId: string): string {
  return join(draftDir(draftId), 'workspace');
}

/**
 * 确保草稿工作区是 git 仓库。
 *
 * OpenCode 的「回退」（session.revert）依赖其快照机制恢复文件，
 * 而快照仅在项目被识别为 git 项目时启用（snapshot enabled ⇔ vcs === "git"）。
 * 草稿工作区位于平台数据目录（~/.unibot-studio/drafts/…），默认不是 git 仓库，
 * 不初始化的话 revert 只会静默「暂存」而不会恢复任何文件——这正是 revert 失效的原因。
 *
 * 幂等：已存在 .git 直接返回 true；git 不可用时返回 false（revert 退化为仅清理对话）。
 */
export function ensureGitWorkspace(draftId: string): boolean {
  const workspace = draftWorkspace(draftId);
  if (!existsSync(workspace)) return false;
  if (existsSync(join(workspace, '.git'))) return true;
  try {
    const res = spawnSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore', timeout: 15_000 });
    const ok = res.status === 0;
    if (ok) {
      logger.info('draft', '已初始化草稿工作区 git 仓库（启用 OpenCode 快照/回退）', {
        draft_id: draftId,
        workspace,
      });
    } else {
      logger.warn('draft', 'git init 失败，回退功能将不可用', {
        draft_id: draftId,
        status: res.status,
        error: res.error?.message,
      });
    }
    return ok;
  } catch (e) {
    logger.warn('draft', 'git init 异常，回退功能将不可用', {
      draft_id: draftId,
      error: (e as Error).message,
    });
    return false;
  }
}

export function draftMetaPath(draftId: string): string {
  return join(draftDir(draftId), 'draft.json');
}

/** 读取草稿元数据 */
export function readDraft(draftId: string): DraftMeta {
  const file = draftMetaPath(draftId);
  if (!existsSync(file)) throw new DraftError('草稿不存在', 'NOT_FOUND');
  return JSON.parse(readFileSync(file, 'utf-8')) as DraftMeta;
}

/** 原子写入草稿元数据（临时文件 + rename，单文件系统内原子） */
export function writeDraft(meta: DraftMeta) {
  const file = draftMetaPath(meta.id);
  mkdirSync(join(draftDir(meta.id)), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  renameSync(tmp, file);
}

/** 更新草稿（统一刷新 updated_at） */
export function updateDraft(draftId: string, patch: Partial<DraftMeta>): DraftMeta {
  const meta = readDraft(draftId);
  const next: DraftMeta = {
    ...meta,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeDraft(next);
  return next;
}

/** 草稿列表（按创建时间倒序） */
export function listDrafts(): DraftMeta[] {
  const root = join(config.data_dir, 'drafts');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, 'draft.json')))
    .map((name) => readDraft(name))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** 用用户的 id/name/description/types 重写一份 Extension.toml（最小脚手架用） */
function renderManifest(opts: {
  extensionId: string;
  name: string;
  description: string;
  types: ExtensionType[];
}): string {
  const typesStr = opts.types.map((t) => `"${t}"`).join(', ');
  let body = MANIFEST_SCAFFOLD
    .replaceAll('{{extension_id}}', opts.extensionId)
    .replaceAll('{{name}}', opts.name)
    .replaceAll('{{description}}', opts.description)
    .replaceAll('{{types}}', typesStr);
  // 无代码类型补上对应目录声明，保证模板/资源扩展开箱即用（Loader 约定目录名）
  if (opts.types.includes('resources') && !body.includes('\n[resources]')) {
    body += `\n[resources]
root = "Resources"
`;
  }
  if (opts.types.includes('template') && !body.includes('\n[template]')) {
    body += `\n[template]
entry = "Templates"
`;
  }
  return body;
}

/** 该扩展类型组合是否需要代码入口（api/command/renderer 任一即命中） */
export function hasCodeType(types: ExtensionType[]): boolean {
  return types.some((t) => CODE_TYPES.includes(t));
}

/** 写最小代码入口与占位测试（代码型扩展的起始基础，AI 会在此基础上实现） */
function writeCodeScaffold(workspace: string, name: string) {
  writeFileSync(join(workspace, '__init__.py'), INIT_SCAFFOLD.replaceAll('{{name}}', name), 'utf-8');
  mkdirSync(join(workspace, 'tests'), { recursive: true });
  writeFileSync(
    join(workspace, 'tests', 'test_extension.py'),
    TEST_SCAFFOLD.replaceAll('{{name}}', name),
    'utf-8',
  );
}

/**
 * 从开发模板生成草稿脚手架。
 * - template 为 `minimal`（或省略）：写入内置脚手架；
 * - template 为 `Default` 等扩展模板：克隆模板源码到工作区，并用用户的
 *   id/名称/描述/类型重写 Extension.toml。
 * 仅当目标是代码型扩展（api/command/renderer）时才补 `__init__.py` 与占位测试；
 * 无代码的模板/资源扩展不长入口，源码即模板开局。
 */
export function scaffoldDraftWorkspace(
  workspace: string,
  opts: { extensionId: string; name: string; description: string; types: ExtensionType[] },
  templateId: string | null | undefined,
): void {
  if (templateId && templateId !== 'minimal') {
    cloneTemplateSource(templateId, workspace);
    rewriteClonedManifest(workspace, opts);
    logger.info('draft', '从扩展模板创建脚手架', {
      template: templateId,
      extension_id: opts.extensionId,
      types: opts.types,
    });
  } else {
    writeFileSync(join(workspace, 'Extension.toml'), renderManifest(opts), 'utf-8');
  }
  if (hasCodeType(opts.types)) {
    // 代码型补救代码入口与占位测试（无论来源是最小脚手架还是模板克隆）
    writeCodeScaffold(workspace, opts.name);
  }
}

/** 重写已克隆模板的 Extension.toml：id/name/description/types（解析→改动→序列化） */
export function rewriteClonedManifest(
  workspace: string,
  opts: { extensionId: string; name: string; description: string; types: ExtensionType[] },
): void {
  const tomlFile = join(workspace, 'Extension.toml');
  let text: string;
  try {
    const doc = parseToml(readFileSync(tomlFile, 'utf-8')) as Record<string, unknown>;
    const extension = (doc.extension ?? {}) as Record<string, unknown>;
    doc.extension = {
      ...extension,
      id: opts.extensionId,
      name: opts.name,
      description: opts.description,
      types: opts.types,
      version: '0.1.0',
      author: 'Studio',
    };
    text = stringifyToml(doc);
  } catch (cause) {
    // 模板清单无法解析时（异常模板），回退为最小清单，避免卡死创建流程
    logger.warn('draft', '模板清单解析失败，回退为最小清单', {
      extension_id: opts.extensionId,
      error: (cause as Error).message,
    });
    text = renderManifest(opts);
  }
  writeFileSync(tomlFile, text, 'utf-8');
}

/** 创建草稿 + 脚手架（对应 Plan.md 3.1） */
export function createDraft(input: {
  extension_id: string;
  name: string;
  description: string;
  types: ExtensionType[];
  model: DraftMeta['model'];
  agent: string;
  /** 开发模板：minimal / Default 等；省略或 minimal 走内置最小脚手架 */
  template_id?: string | null;
  /** 目标 MC 服务器快照（可选）：注入规划/编码提示词，供 AI 结合真实服务器做技术选型 */
  mc_server?: McServerInfo | null;
}): DraftMeta {
  const existing = listDrafts();
  const extensionId = validateExtensionId(input.extension_id, existing);
  // 创建前检查磁盘空间（Plan 11）
  assertDiskSpace(config.data_dir, '创建草稿');
  const draftId = randomUUID();
  const workspace = join(draftWorkspace(draftId), extensionId);
  mkdirSync(workspace, { recursive: true });
  scaffoldDraftWorkspace(
    workspace,
    { extensionId, name: input.name, description: input.description, types: input.types },
    input.template_id,
  );

  // 初始化 git 仓库：OpenCode 快照/回退依赖 git 项目检测（见 ensureGitWorkspace）
  ensureGitWorkspace(draftId);

  const meta: DraftMeta = {
    schema_version: 1,
    id: draftId,
    extension_id: extensionId,
    name: input.name,
    description: input.description,
    types: input.types,
    template_id: input.template_id && input.template_id !== 'minimal' ? input.template_id : null,
    mc_server: input.mc_server ?? null,
    owner_id: 'admin',
    status: 'draft',
    phase: 'planning',
    session_id: null,
    model: input.model,
    model_switched: false,
    agent: input.agent,
    validation: null,
    validation_revision: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
  };
  writeDraft(meta);
  return meta;
}

/** 删除未发布草稿（幂等） */
export function deleteDraft(draftId: string) {
  const meta = readDraft(draftId);
  if (meta.status === 'published') {
    throw new DraftError('已发布草稿不可删除', 'PUBLISHED');
  }
  rmSync(draftDir(draftId), { recursive: true, force: true });
}

/**
 * 路径安全解析：将前端/外部提交的相对路径解析为草稿工作区内的规范路径。
 * 拒绝绝对路径、`..` 越界、符号链接和大小写冲突。
 */
export function resolveDraftPath(draftId: string, rel: string): string {
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new DraftError('不允许绝对路径', 'PATH_VIOLATION');
  }
  const root = resolve(draftWorkspace(draftId));
  const candidate = resolve(root, rel);
  const relFromRoot = relative(root, candidate);
  if (relFromRoot.startsWith('..') || relFromRoot === '' && rel !== '') {
    throw new DraftError('路径越出草稿工作区', 'PATH_VIOLATION');
  }
  // 拒绝路径中的符号链接（逐段检查，覆盖生成过程中插入的越界链接）
  const parts = relFromRoot.split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      throw new DraftError(`文件不存在：${rel}`, 'NOT_FOUND');
    }
    if (st.isSymbolicLink()) {
      throw new DraftError('不允许符号链接', 'PATH_VIOLATION');
    }
  }
  // 大小写冲突：已存在路径与实际名称不一致（macOS 默认大小写不敏感）
  const real = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (existsSync(candidate) && relative(root, real).startsWith('..')) {
    throw new DraftError('路径解析越界', 'PATH_VIOLATION');
  }
  return candidate;
}

/** 文件树/摘要需要忽略的缓存与隐藏条目（与发布过滤一致，见 publishing.ts） */
function isIgnoredEntry(name: string): boolean {
  return name === '__pycache__' || name.startsWith('.');
}

/**
 * 递归列出草稿文件树（供左栏展示与摘要计算）。
 * 跳过 `__pycache__` 等缓存目录与以 `.` 开头的隐藏条目（.git / .pytest_cache /
 * .mypy_cache / .DS_Store 等）：它们不应出现在文件树里，也不应计入文件摘要
 * （否则跑一次测试产生的缓存就会让审查/发布摘要失效）。
 */
export function listFiles(draftId: string): string[] {
  const root = draftWorkspace(draftId);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (isIgnoredEntry(entry)) continue;
      const full = join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 计算草稿文件摘要：对全部文件相对路径 + 内容做 SHA-256。
 * 发布前必须与 validation_revision 完全一致（对应 Plan.md 第四章）。
 */
export function computeRevision(draftId: string): string {
  const root = draftWorkspace(draftId);
  const hash = createHash('sha256');
  for (const rel of listFiles(draftId)) {
    const content = readFileSync(join(root, rel));
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
  }
  return hash.digest('hex');
}

/** 读取草稿内文件内容（限制路径） */
export function readDraftFile(draftId: string, rel: string): string {
  const full = resolveDraftPath(draftId, rel);
  if (statSync(full).isDirectory()) throw new DraftError('目标为目录', 'IS_DIR');
  return readFileSync(full, 'utf-8');
}

/** 代码型扩展类型（需要 __init__.py 入口与代码校验）；无代码类型（template/resources）相反 */
export const CODE_TYPES: ExtensionType[] = ['api', 'command', 'renderer'];

/** 扩展 ID 合法性与类型校验（创建表单用） */
export function sanitizeTypes(types: string[]): ExtensionType[] {
  const allowed: ExtensionType[] = ['api', 'command', 'renderer', 'template', 'resources'];
  const filtered = types.filter((t): t is ExtensionType =>
    allowed.includes(t as ExtensionType),
  );
  if (filtered.length === 0) throw new DraftError('至少选择一种扩展类型', 'INVALID_TYPES');
  return [...new Set(filtered)];
}

/** 草稿是否允许发送新 prompt */
export function assertPromptable(draft: DraftMeta) {
  if (draft.status === 'published') throw new DraftError('已发布草稿为只读', 'PUBLISHED');
  // 规划/编码期间禁止追加消息（前端按钮也应切换为停止）
  if (draft.status === 'planning' || draft.status === 'coding') {
    throw new DraftError('后台任务进行中，请稍候', 'BUSY');
  }
}

/**
 * OpenCode prompt 的 model 参数：把草稿元数据里的模型选择转成 SDK 要求的
 * { providerID, modelID } 形态；未选择模型时返回 undefined（走 opencode 默认配置）。
 * 所有 session.promptAsync 调用都必须带上，否则创建时选的模型只是摆设。
 */
export function promptModelChoice(
  meta: DraftMeta,
): { providerID: string; modelID: string } | undefined {
  if (!meta.model) return undefined;
  return { providerID: meta.model.provider_id, modelID: meta.model.model_id };
}

/**
 * 推断发送新消息后草稿应恢复到的运行阶段：
 * - phase 有效（abort 后继续 / 校验失败后修复）→ 沿用 phase；
 * - phase 缺失（回退 revert / 旧版草稿 / 会话错误恢复后）→ 按工作区是否已有
 *   规划产物（PLAN.md）推断：已有规划说明此前已进入过编码，继续按编码处理；
 *   否则按规划处理。
 * 返回始终是运行阶段（planning/coding），保证「AI 开始工作前状态先进入运行态」，
 * 前端据此正确显示进行中，会话空闲时也能正常触发下一阶段结算。
 */
export function inferResumeStatus(draft: DraftMeta): 'planning' | 'coding' {
  if (draft.phase === 'planning' || draft.phase === 'coding') return draft.phase;
  return existsSync(join(draftWorkspace(draft.id), 'PLAN.md')) ? 'coding' : 'planning';
}
