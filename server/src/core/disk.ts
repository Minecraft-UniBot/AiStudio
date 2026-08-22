/**
 * 磁盘空间检查（对应 Plan.md 11「异常与空状态」）：
 * 创建、检查和发布前检查目标目录所在分区的剩余空间，不足时返回明确错误。
 *
 * 注意：bun 的 fs.statfsSync 在 macOS 上返回 bsize=0（已验证的 bug），
 * 因此这里用系统 df -k 解析剩余空间，保证跨平台准确。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

/** 默认最低剩余空间阈值（字节）：256MB */
export const MIN_FREE_BYTES = 256 * 1024 * 1024;

export interface DiskInfo {
  total: number;
  used: number;
  available: number;
  percent: number;
}

/** 查询目录所在分区的磁盘信息（df -k，1KB 块） */
export function diskInfo(dir: string): DiskInfo {
  mkdirSync(dir, { recursive: true });
  const out = execFileSync('df', ['-k', dir], { encoding: 'utf-8' });
  const lines = out.trim().split('\n');
  const headers = (lines[0] ?? '').split(/\s+/);
  const values = (lines[1] ?? '').split(/\s+/);

  const idx = (key: string): number => headers.findIndex((h) => h.toLowerCase() === key.toLowerCase());
  const num = (key: string, fallback = 0): number => {
    const i = idx(key);
    if (i < 0 || i >= values.length) return fallback;
    const n = Number(values[i]);
    return Number.isFinite(n) ? n * 1024 : fallback; // df -k → 字节
  };

  return {
    total: num('blocks') || num('total'),
    used: num('used'),
    available: num('avail') || num('available'),
    percent: 0,
  };
}

/**
 * 校验目录所在分区剩余空间；不足则抛错（Plan 11：创建/检查/发布前检查）。
 * @param dir 目标目录（会被创建）
 * @param minBytes 最低剩余空间，默认 256MB
 * @param action 动作描述（用于错误信息，如「创建草稿」）
 */
export function assertDiskSpace(dir: string, action: string, minBytes = MIN_FREE_BYTES): void {
  const info = diskInfo(dir);
  if (info.available < minBytes) {
    const freeMb = Math.floor(info.available / 1024 / 1024);
    const needMb = Math.floor(minBytes / 1024 / 1024);
    throw new Error(
      `${action}失败：磁盘剩余空间不足（剩余约 ${freeMb}MB，需要至少 ${needMb}MB）`,
    );
  }
}
