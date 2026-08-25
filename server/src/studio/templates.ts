/**
 * 开发模板扩展（模板注册表）。
 *
 * 概念：新建扩展草稿时，平台以「统一模板」为唯一起点，把官方扩展模板仓库
 * （Minecraft-UniBot/Extension.Example）的标准多文件布局克隆进草稿工作区，
 * 清除其中的示例代码（Commands/Config/Services 等），替换为干净的空白脚手架
 * 并自动改写 Extension.toml（id / name / description / types），由 AI 在此基础上继续实现。
 *
 * 拉取采用 GitHub codeload tar.gz + 系统 tar 解压；模板以独立目录缓存，
 * 带 template.json 元数据标记（防止重复拉取）。路径操作仅限模板目录内。
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../core/config';
import { assertDiskSpace } from '../core/disk';
import { logger } from '../core/logger';
import type { ExtensionType } from '../core/types';
import { runProcess } from './unibot_env';

/** 统一模板 id：全部草稿的唯一脚手架来源 */
export const UNIFIED_TEMPLATE_ID = 'Example';

/** 模板信息（供新建草稿对话框与模板管理 API 展示） */
export interface TemplateInfo {
  id: string;
  /** extension = 从 GitHub 拉取并缓存的扩展模板源（可克隆） */
  kind: 'extension';
  name: string;
  description: string;
  /** 模板基础的扩展类型（统一模板覆盖 api + command，其余类型由清单改写声明目录） */
  types: ExtensionType[];
  /** 来源 GitHub 仓库 */
  repo?: string;
  /** 仓库内作为扩展根的子目录（如 Extension.Example 仓库的 `Extension/`） */
  entry?: string;
  /** 是否已拉取/缓存完成 */
  installed: boolean;
  /** 模板清单中的扩展版本（从缓存 Extension.toml 读取） */
  version: string | null;
  /** 拉取/缓存的更新时间 */
  updated_at: string | null;
}

/** 模板注册表（当前仅统一模板一项；后续可扩展为从 market/配置读取） */
const TEMPLATE_REGISTRY: Omit<TemplateInfo, 'installed' | 'version' | 'updated_at'>[] = [
  {
    id: UNIFIED_TEMPLATE_ID,
    kind: 'extension',
    name: '统一模板',
    description:
      '官方扩展模板仓库（Extension.Example）的标准多文件布局；克隆时自动清除示例代码，替换为干净的空白脚手架。',
    types: ['api', 'command'],
    repo: 'Minecraft-UniBot/Extension.Example',
    entry: 'Extension',
  },
];

/** 统一模板内的官方示例代码文件（克隆进草稿时清除，替换为干净脚手架） */
const TEMPLATE_EXAMPLE_FILES = ['Commands.py', 'Config.py', 'Services.py'];

/**
 * 清除统一模板中的示例代码文件（保留清单；入口 `__init__.py` 由草稿脚手架重写或移除）。
 * 按固定文件名清除而非清空整个目录：模板未来新增非代码素材时不受影响。
 */
export function stripTemplateExamples(dir: string): void {
  for (const name of TEMPLATE_EXAMPLE_FILES) {
    rmSync(join(dir, name), { force: true });
  }
}

/** 模板根目录（<data_dir>/templates） */
export function templatesRoot(): string {
  return join(config.data_dir, 'templates');
}

/** 单个模板目录 */
export function templateDir(templateId: string): string {
  return join(templatesRoot(), templateId);
}

/** 模板目录内扩展根（extension 类型模板的源码根目录） */
export function templateSourceDir(templateId: string): string {
  return join(templateDir(templateId), 'source');
}

/** 模板目录内「仓库级」文件根（.github/workflows、LICENSE、README 等，市场上传脚手架用） */
export function templateRepoDir(templateId: string): string {
  return join(templateDir(templateId), 'repo');
}

/** 模板元信息文件 */
function markerPath(templateId: string): string {
  return join(templateDir(templateId), 'template.json');
}

function readMarker(templateId: string): Record<string, unknown> | null {
  const file = markerPath(templateId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 读取模板 Extension.toml 中的版本与类型（用于展示与校验） */
function readTemplateSourceMeta(templateId: string): { version: string | null; types: ExtensionType[] } {
  const dir = templateSourceDir(templateId);
  const tomlFile = join(dir, 'Extension.toml');
  if (!existsSync(tomlFile)) return { version: null, types: [] };
  try {
    // 轻量正则读取（避免重复引入 TOML 解析依赖；字段均在清单固定位置）
    const text = readFileSync(tomlFile, 'utf-8');
    const version = text.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    const typesMatch = text.match(/^\s*types\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
    const types = (typesMatch.match(/"([A-Za-z]+)"/g) ?? [])
      .map((m) => m.slice(1, -1))
      .filter((t): t is ExtensionType =>
        ['api', 'command', 'renderer', 'template', 'resources'].includes(t),
      );
    return { version, types };
  } catch {
    return { version: null, types: [] };
  }
}

/** 解析注册表模板的最新状态（installed / version / updated_at） */
function resolveTemplate(entry: (typeof TEMPLATE_REGISTRY)[number]): TemplateInfo {
  const marker = readMarker(entry.id);
  const installed = existsSync(join(templateSourceDir(entry.id), 'Extension.toml'));
  const sourceMeta = readTemplateSourceMeta(entry.id);
  return {
    ...entry,
    installed,
    types: sourceMeta.types.length > 0 ? sourceMeta.types : entry.types,
    version: sourceMeta.version ?? (marker?.version as string | undefined) ?? null,
    updated_at: (marker?.updated_at as string | undefined) ?? null,
  };
}

/** 返回全部模板（用于新建草稿对话框 / GET /api/studio/templates） */
export function listTemplates(): TemplateInfo[] {
  return TEMPLATE_REGISTRY.map(resolveTemplate);
}

/** 读取单个模板信息 */
export function getTemplate(templateId: string): TemplateInfo {
  const entry = TEMPLATE_REGISTRY.find((t) => t.id === templateId);
  if (!entry) throw new Error(`未知模板：${templateId}`);
  return resolveTemplate(entry);
}

/** 是否已安装（可克隆进草稿） */
export function isTemplateInstalled(templateId: string): boolean {
  return getTemplate(templateId).installed;
}

/**
 * 拉取并缓存单个 extension 模板（从 GitHub codeload tar.gz 下载后解压内置 `Extension/` 子目录）。
 * 幂等：已安装则直接返回 true；失败抛错并清理半成品目录。
 */
export async function pullTemplate(templateId: string): Promise<TemplateInfo> {
  const entry = TEMPLATE_REGISTRY.find((t) => t.id === templateId);
  if (!entry || entry.kind !== 'extension' || !entry.repo || !entry.entry) {
    throw new Error(`模板「${templateId}」不支持从 GitHub 拉取`);
  }
  assertDiskSpace(config.data_dir, '拉取开发模板');
  const dest = templateDir(templateId);
  mkdirSync(dest, { recursive: true });
  const staging = join(dest, '.staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // 触发磁盘空间检查后下载（tar.gz）
  const tarballUrl = `https://codeload.github.com/${entry.repo}/tar.gz/refs/heads/main`;
  logger.info('templates', '开始下载开发模板', { template: templateId, url: tarballUrl });
  const tarballPath = join(staging, 'template.tar.gz');
  const download = await fetch(tarballUrl, { redirect: 'follow' });
  if (!download.ok) throw new Error(`模板下载失败：HTTP ${download.status}`);
  writeFileSync(tarballPath, Buffer.from(await download.arrayBuffer()));

  const extractDir = join(staging, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  const extract = await runProcess('tar', ['-xzf', tarballPath, '-C', extractDir]);
  if (extract.code !== 0) {
    throw new Error(`模板解压失败：${extract.output.slice(-400)}`);
  }

  // 在解压目录中定位 entry 子目录（如 Extension/），作为真正的扩展源码根
  const entryDir = findEntryDir(extractDir, entry.entry);
  if (!entryDir) throw new Error(`模板仓库未找到扩展目录「${entry.entry}」`);

  const sourceDir = templateSourceDir(templateId);
  mkdirSync(join(dest), { recursive: true });
  // 原子替换：先复制到 staging/source，再 rename 到正式 source（同一文件系统）
  const stagedSource = join(staging, 'source');
  mkdirSync(stagedSource, { recursive: true });
  copyTree(entryDir, stagedSource);
  if (!existsSync(join(stagedSource, 'Extension.toml'))) {
    throw new Error('模板扩展根缺少 Extension.toml');
  }
  rmSync(sourceDir, { recursive: true, force: true });
  renameSync(stagedSource, sourceDir);

  // 缓存「仓库级」文件（.github/workflows、LICENSE、README、.gitignore）：
  // 市场上传脚手架按 Extension.Example 仓库布局生成扩展仓库（含完整打包 workflow），
  // 这些文件在 entry 子目录之外，且 copyTree 会跳过隐藏目录，需单独复制。
  // 缺失不致命（老模板缓存/仓库改版），脚手架会退化为不复制这些文件。
  const repoRoot = dirname(entryDir);
  const stagedRepo = join(staging, 'repo');
  mkdirSync(stagedRepo, { recursive: true });
  try {
    copyRepoExtras(repoRoot, stagedRepo);
    // 原子替换 repo 目录（同 source 的 staging -> rename 模式）
    const repoDir = templateRepoDir(templateId);
    rmSync(repoDir, { recursive: true, force: true });
    renameSync(stagedRepo, repoDir);
  } catch (e) {
    logger.warn('templates', '缓存模板仓库级文件失败（不影响模板使用）', {
      template: templateId,
      error: (e as Error).message,
    });
  }

  // 写元信息标记
  const now = new Date().toISOString();
  writeFileSync(
    markerPath(templateId),
    JSON.stringify(
      { id: templateId, repo: entry.repo, entry: entry.entry, updated_at: now },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  rmSync(staging, { recursive: true, force: true });

  logger.info('templates', '开发模板已就绪', { template: templateId, repo: entry.repo });
  return getTemplate(templateId);
}

/** 在解压目录中定位 entry 相对子目录（不超过两层层级扫描，适配仓库顶层目录包装） */
function findEntryDir(extractRoot: string, relativeEntry: string): string | null {
  // codeload tarball 根通常为 `<repo>-<ref>/`（一层包装），在此之上按 entry 逐段查找
  const candidates: string[] = [extractRoot];
  for (const child of readdirSync(extractRoot)) {
    const full = join(extractRoot, child);
    if (statSync(full).isDirectory()) candidates.push(full);
  }
  for (const base of candidates) {
    let cursor = base;
    for (const segment of relativeEntry.split('/')) {
      if (!segment) continue;
      const next = join(cursor, segment);
      if (!existsSync(next) || !statSync(next).isDirectory()) {
        cursor = '';
        break;
      }
      cursor = next;
    }
    if (cursor) return cursor;
  }
  return null;
}

/** 仓库级目录白名单（市场上传脚手架需要复刻的 Extension.Example 布局） */
const REPO_EXTRA_ENTRIES = ['.github', 'LICENSE', 'README.md', '.gitignore'];

/**
 * 复制模板仓库的「仓库级」文件到目标目录（保留隐藏目录如 .github，
 * 跳过 .git 与符号链接）。仅复制白名单条目，entry 子目录不重复复制。
 */
function copyRepoExtras(repoRoot: string, dest: string): void {
  for (const name of REPO_EXTRA_ENTRIES) {
    const src = join(repoRoot, name);
    if (!existsSync(src) || lstatSync(src).isSymbolicLink()) continue;
    const st = statSync(src);
    const target = join(dest, name);
    if (st.isDirectory()) {
      copyTreeIncludingHidden(src, target);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(src, target);
    }
  }
}

/** 与 copyTree 相同，但保留隐藏文件/目录（.github/workflows 必需） */
function copyTreeIncludingHidden(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === '__pycache__' || entry === '.git') continue;
    const fullSrc = join(src, entry);
    const fullDest = join(dest, entry);
    const st = lstatSync(fullSrc);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTreeIncludingHidden(fullSrc, fullDest);
    else copyFileSync(fullSrc, fullDest);
  }
}

/** 模板是否已缓存仓库级文件（市场上传脚手架可用性判定） */
export function templateRepoExtrasAvailable(templateId: string): boolean {
  return existsSync(join(templateRepoDir(templateId), '.github', 'workflows'));
}

/**
 * 复制模板缓存的「仓库级」文件（.github/workflows、LICENSE、README.md、.gitignore）
 * 到目标目录（市场上传脚手架用，见 studio/market.ts）。保留隐藏目录（.github）。
 * 返回实际复制的条目名；缺失的条目静默跳过（老缓存/仓库改版不致命）。
 */
export function copyTemplateRepoExtras(templateId: string, destDir: string): string[] {
  const repoDir = templateRepoDir(templateId);
  const copied: string[] = [];
  for (const name of REPO_EXTRA_ENTRIES) {
    const src = join(repoDir, name);
    if (!existsSync(src) || lstatSync(src).isSymbolicLink()) continue;
    const st = statSync(src);
    const target = join(destDir, name);
    if (st.isDirectory()) {
      copyTreeIncludingHidden(src, target);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(src, target);
    }
    copied.push(name);
  }
  return copied;
}

/** 递归复制一棵目录（跳过隐藏/缓存条目；遵循 5.2 的忽略规则，与发布过滤一致） */
export function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === '__pycache__' || entry === '.git' || entry.startsWith('.')) continue;
    const fullSrc = join(src, entry);
    const fullDest = join(dest, entry);
    const st = statSync(fullSrc);
    if (st.isSymbolicLink()) continue; // 拒绝符号链接（安全约束，见 drafts.resolveDraftPath）
    if (st.isDirectory()) copyTree(fullSrc, fullDest);
    else {
      // 对文本类文件避免复制大格式资源时出错：一律以字节复制
      mkdirSync(dest, { recursive: true });
      const data = readFileSync(fullSrc);
      writeFileSync(fullDest, data);
    }
  }
}

/**
 * 初始化：确保统一模板可用；尚未拉取时在后台拉取（不阻塞启动）。
 * 启动时调用；失败仅记日志，用户可随时通过模板接口重试。
 */
export function ensureTemplatesInit(): void {
  mkdirSync(templatesRoot(), { recursive: true });
  const info = getTemplate(UNIFIED_TEMPLATE_ID);
  if (!info.installed) {
    void pullTemplate(UNIFIED_TEMPLATE_ID)
      .then((t) => logger.info('templates', '统一模板初始化完成', { template: t.id }))
      .catch((e) =>
        logger.warn('templates', '统一模板初始化失败（可稍后重试）', {
          error: (e as Error).message,
        }),
      );
  }
}

/**
 * 复刻模板的 `Extension/` 下完整文件到目标目录（供 createDraft 克隆模板进草稿）。
 * 仅允许 extension 类型模板；未安装时抛错。返回克隆文件是否为「扩展源模板」。
 */
export function cloneTemplateSource(templateId: string, destDir: string): void {
  const info = getTemplate(templateId);
  if (info.kind !== 'extension' || !info.installed) {
    throw new Error(`模板「${templateId}」不可作为扩展源克隆（未安装或非扩展模板）`);
  }
  copyTree(templateSourceDir(templateId), destDir);
}