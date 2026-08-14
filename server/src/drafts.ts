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
import { config } from './config';
import { assertDiskSpace } from './disk';
import { logger } from './logger';
import type { DraftMeta, ExtensionType } from './types';

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

/** 创建草稿 + 脚手架（对应 Plan.md 3.1） */
export function createDraft(input: {
  extension_id: string;
  name: string;
  description: string;
  types: ExtensionType[];
  model: DraftMeta['model'];
  agent: string;
}): DraftMeta {
  const existing = listDrafts();
  const extensionId = validateExtensionId(input.extension_id, existing);
  // 创建前检查磁盘空间（Plan 11）
  assertDiskSpace(config.data_dir, '创建草稿');
  const draftId = randomUUID();
  const workspace = join(draftWorkspace(draftId), extensionId);
  mkdirSync(join(workspace, 'tests'), { recursive: true });

  const typesStr = input.types.map((t) => `"${t}"`).join(', ');
  writeFileSync(
    join(workspace, 'Extension.toml'),
    MANIFEST_SCAFFOLD
      .replaceAll('{{extension_id}}', extensionId)
      .replaceAll('{{name}}', input.name)
      .replaceAll('{{description}}', input.description)
      .replaceAll('{{types}}', typesStr),
    'utf-8',
  );
  writeFileSync(
    join(workspace, '__init__.py'),
    INIT_SCAFFOLD.replaceAll('{{name}}', input.name),
    'utf-8',
  );
  writeFileSync(
    join(workspace, 'tests', 'test_extension.py'),
    TEST_SCAFFOLD.replaceAll('{{name}}', input.name),
    'utf-8',
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
    owner_id: 'admin',
    status: 'draft',
    session_id: null,
    review_session_id: null,
    model: input.model,
    agent: input.agent,
    review: null,
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

/** 递归列出草稿文件树（供左栏展示与摘要计算） */
export function listFiles(draftId: string): string[] {
  const root = draftWorkspace(draftId);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
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

/** 扩展 ID 合法性与类型校验（创建表单用） */
export function sanitizeTypes(types: string[]): ExtensionType[] {
  const allowed: ExtensionType[] = ['api', 'command'];
  const filtered = types.filter((t): t is ExtensionType =>
    allowed.includes(t as ExtensionType),
  );
  if (filtered.length === 0) throw new DraftError('至少选择一种扩展类型', 'INVALID_TYPES');
  return [...new Set(filtered)];
}

/** 草稿是否允许发送新 prompt */
export function assertPromptable(draft: DraftMeta) {
  if (draft.status === 'published') throw new DraftError('已发布草稿为只读', 'PUBLISHED');
  // 生成/校验/审核/修复/调试期间禁止追加消息（前端按钮也应切换为停止）
  if (
    draft.status === 'generating' ||
    draft.status === 'checking' ||
    draft.status === 'reviewing' ||
    draft.status === 'repairing' ||
    draft.status === 'debugging'
  ) {
    throw new DraftError('后台任务进行中，请稍候', 'BUSY');
  }
}
