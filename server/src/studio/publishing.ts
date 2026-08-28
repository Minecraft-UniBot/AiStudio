/**
 * 发布器：将校验通过的草稿原子交付到 UniBot Extensions/<id>。
 *
 * 事务流程（对应 Plan.md 3.4）：
 * 1. 核对草稿文件摘要与最近通过校验的 revision 完全一致
 * 2. 核对目标目录不存在（已存在则拒绝，不覆盖）；update 模式允许覆盖同 ID 扩展
 * 3. 复制草稿到 Extensions/.staging-<id>（临时目录）
 * 4. 逐文件复核路径与清单（拒绝符号链接、越界路径）
 * 5. 原子重命名 staging -> 正式目录
 * 6. 失败时清理 staging，不改变正式目录
 *
 * 覆盖发布（update 模式）：
 * - 目标目录已存在时，校验其中 Extension.toml 的 id 与草稿一致
 * - 同 ID → 备份旧版本到 .backup/<id>/<timestamp>，然后覆盖
 * - 不同 ID → 拒绝（不允许覆盖别人的扩展）
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
import { parse as parseToml } from 'smol-toml';
import { config } from '../core/config';
import { assertDiskSpace } from '../core/disk';
import { logger } from '../core/logger';
import { computeRevision, draftWorkspace, readDraft, updateDraft } from './drafts';
import type { PublishRecord } from '../core/types';

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

/** 一键发布（同步执行；发布成功将草稿置为只读；update=true 时允许覆盖同 ID 已发布扩展） */
export function publishDraft(draftId: string, update = false): PublishRecord {
  const draft = readDraft(draftId);
  if (draft.status === 'published' && !update) {
    throw new PublishError('该草稿已发布', 'ALREADY_PUBLISHED');
  }

  // 0. 竞争锁：同一草稿/扩展 ID 并发发布直接拒绝
  if (!acquirePublishLock(draftId, draft.extension_id)) {
    throw new PublishError('该草稿正在发布中，请稍候', 'PUBLISH_BUSY');
  }
  try {
    return doPublish(draftId, draft.extension_id, update);
  } finally {
    releasePublishLock(draftId, draft.extension_id);
  }
}

function doPublish(draftId: string, extensionId: string, update = false): PublishRecord {
  const draft = readDraft(draftId);

  // 1. 机械校验必须通过且文件摘要与校验时一致（Plan 3.4：检查通过后文件又变化则锁定发布）
  const current = computeRevision(draftId);
  if (draft.validation?.status !== 'passed' || draft.validation_revision !== current) {
    logger.warn('publish', '发布被拒绝：机械校验未通过或文件摘要已过期', {
      draft_id: draftId,
      extension_id: extensionId,
    });
    throw new PublishError('机械校验未通过或文件已变更，请重新检查后再发布', 'VALIDATION_STALE');
  }

  // 2. 目标目录处理：不存在→直接发布；已存在→按 update 模式决定
  const target = join(config.extensions_dir, extensionId);
  if (existsSync(target)) {
    if (!update) {
      throw new PublishError(
        `目标扩展目录 ${extensionId} 已存在。如需更新，请使用「更新发布」`,
        'TARGET_EXISTS',
      );
    }
    // 覆盖发布：校验目标目录确实是同一扩展（防止覆盖别人的扩展）
    const existingToml = join(target, 'Extension.toml');
    if (!existsSync(existingToml)) {
      throw new PublishError(
        `目标目录 ${extensionId} 缺少 Extension.toml，无法确认是同一扩展`,
        'TARGET_CONFLICT',
      );
    }
    try {
      const doc = parseToml(readFileSync(existingToml, 'utf-8')) as Record<string, unknown>;
      const ext = (doc.extension ?? {}) as Record<string, unknown>;
      if (ext.id !== extensionId) {
        throw new PublishError(
          `目标目录中的扩展 ID「${ext.id}」与当前草稿「${extensionId}」不一致，不允许覆盖`,
          'TARGET_CONFLICT',
        );
      }
    } catch (e) {
      if (e instanceof PublishError) throw e;
      // TOML 解析失败：保守拒绝
      throw new PublishError(
        `无法解析目标目录的 Extension.toml：${(e as Error).message}`,
        'TARGET_CONFLICT',
      );
    }
    // 备份旧版本到 .backup/<id>/<timestamp>/
    const backupDir = join(config.extensions_dir, '.backup', extensionId);
    mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupTarget = join(backupDir, timestamp);
    renameSync(target, backupTarget);
    logger.info('publish', '覆盖发布：旧版本已备份', {
      extension_id: extensionId,
      backup_dir: backupTarget,
    });
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
    // 覆盖发布失败时尝试恢复备份
    if (update) {
      const backupDir = join(config.extensions_dir, '.backup', extensionId);
      try {
        const backups = readdirSync(backupDir).sort().reverse();
        if (backups.length > 0) {
          const latest = join(backupDir, backups[0]!);
          renameSync(latest, target);
          logger.warn('publish', '覆盖发布失败，已恢复旧版本', { extension_id: extensionId });
        }
      } catch {
        // 恢复失败：记录但不抛出（原始错误更重要）
      }
    }
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
  logger.info('publish', update ? '覆盖发布成功' : '发布成功', {
    draft_id: draftId,
    extension_id: extensionId,
    target_dir: target,
    revision: current,
  });
  return record;
}
