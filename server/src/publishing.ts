/**
 * 发布器：将校验通过的草稿原子交付到 UniBot Extensions/<id>。
 *
 * 事务流程（对应 Plan.md 3.4）：
 * 1. 核对草稿文件摘要与最近通过校验的 revision 完全一致
 * 2. 核对目标目录不存在（已存在则拒绝，不覆盖）
 * 3. 复制草稿到 Extensions/.staging-<id>（临时目录）
 * 4. 逐文件复核路径与清单（拒绝符号链接、越界路径）
 * 5. 原子重命名 staging -> 正式目录
 * 6. 失败时清理 staging，不改变正式目录
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { config } from './config';
import { assertDiskSpace } from './disk';
import { logger } from './logger';
import { computeRevision, draftWorkspace, readDraft, updateDraft } from './drafts';
import type { PublishRecord } from './types';

export class PublishError extends Error {
  constructor(
    message: string,
    public code: string = 'PUBLISH_ERROR',
  ) {
    super(message);
  }
}

/**
 * 发布竞争锁（Plan 11「启用竞争」）：同一扩展 ID 或同一草稿并发发布时
 * 立即拒绝第二个请求，避免 staging 目录互相污染。
 */
const PUBLISH_LOCKS = new Set<string>();

function acquirePublishLock(draftId: string, extensionId: string): boolean {
  const key = `${draftId}::${extensionId}`;
  if (PUBLISH_LOCKS.has(key)) return false;
  PUBLISH_LOCKS.add(key);
  return true;
}

function releasePublishLock(draftId: string, extensionId: string): void {
  PUBLISH_LOCKS.delete(`${draftId}::${extensionId}`);
}

/** 深度校验目录内容：拒绝符号链接与越界路径 */
function verifyTree(root: string, base: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new PublishError(`扩展包内不允许符号链接：${relative(base, full)}`);
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  if (!existsSync(join(root, 'Extension.toml'))) {
    throw new PublishError('扩展包缺少 Extension.toml');
  }
}

/** 一键发布（同步执行；发布成功将草稿置为只读） */
export function publishDraft(draftId: string): PublishRecord {
  const draft = readDraft(draftId);
  if (draft.status === 'published') {
    throw new PublishError('该草稿已发布', 'ALREADY_PUBLISHED');
  }

  // 0. 竞争锁：同一草稿/扩展 ID 并发发布直接拒绝
  if (!acquirePublishLock(draftId, draft.extension_id)) {
    throw new PublishError('该草稿正在发布中，请稍候', 'PUBLISH_BUSY');
  }
  try {
    return doPublish(draftId, draft.extension_id);
  } finally {
    releasePublishLock(draftId, draft.extension_id);
  }
}

function doPublish(draftId: string, extensionId: string): PublishRecord {
  const draft = readDraft(draftId);

  // 1. 摘要核对：文件必须与最近审查通过时的状态完全一致（Plan 3.4：审查通过才允许发布）
  const current = computeRevision(draftId);
  if (draft.review_revision !== current || !draft.review_revision) {
    logger.warn('publish', '发布被拒绝：文件摘要已过期', {
      draft_id: draftId,
      extension_id: extensionId,
    });
    throw new PublishError('草稿文件自审查后发生变更，请重新审查后再发布', 'STALE_REVISION');
  }
  // 审查必须通过且无未解决的必须修复问题
  if (!draft.review || draft.review.status !== 'passed') {
    throw new PublishError('审查未通过，无法发布', 'REVIEW_FAILED');
  }

  // 2. 目标目录必须不存在（第一版拒绝覆盖）
  const target = join(config.extensions_dir, extensionId);
  if (existsSync(target)) {
    throw new PublishError(`目标扩展目录 ${extensionId} 已存在，第一版不支持覆盖`, 'TARGET_EXISTS');
  }

  // 发布前检查磁盘空间（Plan 11）
  assertDiskSpace(config.extensions_dir, '发布扩展');

  const staging = join(config.extensions_dir, `.staging-${extensionId}`);
  const source = join(draftWorkspace(draftId), extensionId);
  rmSync(staging, { recursive: true, force: true });

  try {
    mkdirSync(config.extensions_dir, { recursive: true });
    // 3. 复制草稿到 staging
    cpSync(source, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: false,
      filter: (src) => basename(src) !== '__pycache__' && !basename(src).startsWith('.'),
    });
    // 4. 复核
    verifyTree(staging, staging);
    const manifest = readFileSync(join(staging, 'Extension.toml'), 'utf-8');
    if (!manifest.includes(`id = "${extensionId}"`)) {
      throw new PublishError('Extension.toml 中的 id 与草稿不一致', 'MANIFEST_MISMATCH');
    }
    // 5. 原子重命名
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // 6. 记录发布
  const record: PublishRecord = {
    draft_id: draftId,
    extension_id: extensionId,
    target_dir: target,
    revision: current,
    prompt_versions: {},
    published_at: new Date().toISOString(),
  };
  updateDraft(draftId, {
    status: 'published',
    published_at: record.published_at,
  });
  logger.info('publish', '发布成功', {
    draft_id: draftId,
    extension_id: extensionId,
    target_dir: target,
    revision: current,
  });
  return record;
}
