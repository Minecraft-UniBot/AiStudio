/**
 * MC 服务器扫描：选择服务器目录后识别服务端类型（Paper/Spigot/Fabric/Forge/NeoForge 等）、
 * 游戏版本与插件/模组清单，供创建草稿时快照进草稿元数据、注入 AI 提示词做技术选型。
 *
 * 实现要点：
 * - jar 清单解析用最小 ZIP 读取器：只从文件尾部定位中央目录 + 按需解压小条目
 *   （plugin.yml / fabric.mod.json / mods.toml），不整包读入内存，大模组也不卡顿
 * - 服务端类型探测优先级：根目录核心 jar 文件名 > libraries 加载器目录 > logs/latest.log
 * - 扫描结果持久化到 config.mc_server_dir；创建草稿时整体快照，保证提示词可复现
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { config, saveConfig } from './config';
import type { McPackageEntry, McServerInfo } from './types';

export class McServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McServerError';
  }
}

/** 单端插件/模组数量上限（防御异常目录；正常服务器远小于此值） */
const MAX_PACKAGES = 500;

// ===== 最小 ZIP 读取器（仅支持本模块需要的「按名读取条目」） =====

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  /** 本地文件头在 jar 内的偏移 */
  localOffset: number;
}

/**
 * 解析中央目录（EOCD → CD 条目列表）。只读元数据，不解压任何内容。
 * 不校验 CRC32：清单读取失败时上层会回退为文件名展示，无需完整性保证。
 */
async function parseZipEntries(handle: FileHandle, fileSize: number) {
  const entries = new Map<string, ZipEntry>();
  // EOCD 固定 22 字节 + 最长 65535 注释；从尾部窗口中反向搜索签名 PK\x05\x06
  const tailSize = Math.min(fileSize, 22 + 65535);
  const tail = Buffer.alloc(tailSize);
  await handle.read(tail, 0, tailSize, fileSize - tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries; // 非法/多卷 zip：按无条目处理
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cdSize = tail.readUInt32LE(eocd + 12);
  if (!cdOffset || !cdSize) return entries;
  const cd = Buffer.alloc(Math.min(cdSize, fileSize));
  await handle.read(cd, 0, cd.length, cdOffset);

  const decoder = new TextDecoder();
  let pos = 0;
  while (pos + 46 <= cd.length && cd.readUInt32LE(pos) === 0x02014b50) {
    const method = cd.readUInt16LE(pos + 10);
    const compressedSize = cd.readUInt32LE(pos + 20);
    const size = cd.readUInt32LE(pos + 24);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const localOffset = cd.readUInt32LE(pos + 42);
    const name = decoder.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
    entries.set(name, { method, compressedSize, size, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipReadEntry(
  handle: FileHandle,
  entry: ZipEntry,
): Promise<Buffer | null> {
  try {
    // 本地文件头 30 字节固定区 + 文件名 + 额外字段（长度以本地头为准，可能与 CD 不同）
    const head = Buffer.alloc(30);
    await handle.read(head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) return null;
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const raw = Buffer.alloc(entry.compressedSize);
    await handle.read(raw, 0, raw.length, dataStart);
    if (entry.method === 0) return raw; // stored
    if (entry.method === 8) return inflateRawSync(raw); // deflate
    return null;
  } catch {
    return null;
  }
}

/** 已打开的 jar：按名读取单个条目文本（找不到或解压失败返回 null） */
class JarFile {
  private constructor(
    private handle: FileHandle,
    private entries: Map<string, ZipEntry>,
  ) {}

  static async open(path: string): Promise<JarFile> {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      const entries = await parseZipEntries(handle, size);
      return new JarFile(handle, entries);
    } catch (e) {
      await handle.close();
      throw e;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async readText(name: string): Promise<string | null> {
    const entry = this.entries.get(name);
    if (!entry || entry.size > 4 * 1024 * 1024) return null; // 清单不会超过几 KB，上限防御
    const buf = await zipReadEntry(this.handle, entry);
    if (!buf) return null;
    return buf.toString('utf-8');
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

// ===== jar 内清单解析（Bukkit / Fabric / Forge / NeoForge / Quilt / 老 Forge） =====

interface JarMeta {
  name?: string;
  version?: string;
  depends?: string[];
}

/** 从 plugin.yml 提取 name/version/depend/softdepend（轻量解析，不引入 YAML 依赖） */
function parsePluginYml(text: string): JarMeta {
  const scalar = (key: string): string | undefined => {
    const m = text.match(new RegExp(`^${key}:\\s*["']?([^"'#\\n]+?)["']?\\s*$`, 'm'));
    return m ? m[1]!.trim() : undefined;
  };
  const list = (key: string): string[] => {
    const inline = text.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, 'm'));
    if (inline) {
      return inline[1]!
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    // 块列表形式：depend:\n- A\n- B（缩进可省略；只取该键紧随的连续 "- x" 行）
    const block = text.match(new RegExp(`^${key}:\\s*\\n((?:[ \\t]*-[^\n]*\\n?)+)`, 'm'));
    if (block) {
      return [...block[1]!.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*(?:\n|$)/g)]
        .map((m) => m[1]!.trim())
        .filter(Boolean);
    }
    return [];
  };
  const meta: JarMeta = {};
  const name = scalar('name');
  const version = scalar('version');
  if (name) meta.name = name;
  if (version) meta.version = version;
  const depends = [...new Set([...list('depend'), ...list('softdepend')])];
  if (depends.length) meta.depends = depends.slice(0, 20);
  return meta;
}

function parseFabricModJson(text: string): JarMeta {
  const json = JSON.parse(text) as {
    id?: string;
    name?: string;
    version?: string;
    depends?: Record<string, string>;
  };
  const meta: JarMeta = {
    name: json.name ?? json.id,
    version: json.version,
  };
  const depends = Object.keys(json.depends ?? {}).filter((k) => k !== 'minecraft' && k !== 'java');
  if (depends.length) meta.depends = depends.slice(0, 20);
  return meta;
}

function parseModsToml(text: string): JarMeta {
  const doc = parseToml(text) as {
    mods?: Array<{ modId?: string; displayName?: string; version?: string }>;
    dependencies?: Record<string, Record<string, unknown>>;
  };
  const first = doc.mods?.[0];
  const meta: JarMeta = {
    name: first?.displayName || first?.modId,
    version: normalizeTomlVersion(first?.version),
  };
  const depends = Object.keys(doc.dependencies ?? {});
  if (depends.length) meta.depends = depends.filter((d) => d !== 'minecraft' && d !== 'java').slice(0, 20);
  return meta;
}

/** mods.toml 的 version 支持 "${file.jarVersion}" 占位符：无法确定时显示为空 */
function normalizeTomlVersion(v?: string): string | undefined {
  if (!v) return undefined;
  if (v.includes('${')) return undefined;
  return v;
}

function parseMcModInfo(text: string): JarMeta {
  const json = JSON.parse(text.trim()) as
    | Array<{ modid?: string; name?: string; version?: string }>
    | { modList?: Array<{ modid?: string; name?: string; version?: string }> };
  const list = Array.isArray(json) ? json : (json.modList ?? []);
  const first = list[0];
  if (!first) return {};
  return { name: first.name || first.modid, version: first.version };
}

/** Quilt 的 quilt.mod.json：元数据嵌套在 quilt_loader 下（与 Fabric 扁平结构不同） */
function parseQuiltModJson(text: string): JarMeta {
  const json = JSON.parse(text) as {
    quilt_loader?: {
      id?: string;
      version?: string;
      metadata?: { name?: string };
      depends?: Array<{ id?: string }>;
    };
  };
  const loader = json.quilt_loader;
  if (!loader) return {};
  const meta: JarMeta = {
    name: loader.metadata?.name || loader.id,
    version: loader.version,
  };
  const depends = (loader.depends ?? [])
    .map((d) => d.id ?? '')
    .filter((id) => id && id !== 'minecraft' && id !== 'java' && id !== 'quilt_loader');
  if (depends.length) meta.depends = depends.slice(0, 20);
  return meta;
}

/** 依次尝试各平台的清单文件，返回首个命中的结果 */
async function readJarMeta(jar: JarFile): Promise<JarMeta> {
  for (const [file, parser] of [
    ['plugin.yml', parsePluginYml],
    ['paper-plugin.yml', parsePluginYml],
    ['fabric.mod.json', parseFabricModJson],
    ['META-INF/neoforge.mods.toml', parseModsToml],
    ['META-INF/mods.toml', parseModsToml],
    ['mcmod.info', parseMcModInfo],
    ['quilt.mod.json', parseQuiltModJson],
  ] as const) {
    if (!jar.has(file)) continue;
    try {
      const text = await jar.readText(file);
      if (!text) continue;
      const meta = parser(text);
      if (meta.name || meta.version) return meta;
    } catch {
      // 清单损坏：继续尝试其他格式，最终回退文件名
    }
  }
  return {};
}

// ===== 服务端类型 / 版本探测 =====

const SERVER_TYPES: Record<string, string> = {
  paper: 'Paper',
  purpur: 'Purpur',
  folia: 'Folia',
  spigot: 'Spigot',
  craftbukkit: 'CraftBukkit',
  bukkit: 'Bukkit 系',
  vanilla: 'Vanilla 官方端',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
};

/**
 * 从字符串中提取 Minecraft 版本号（1.x 或 1.x.y）。
 * 次版本号限制在 ≤ 30：避免把构建号误读成游戏版本（如 NeoForge「21.1.57」中的「1.57」）；
 * 超出范围时返回 null，由调用方回退到下一个来源（日志等）。
 */
function extractMcVersion(...sources: Array<string | null | undefined>): string | null {
  for (const source of sources) {
    if (!source) continue;
    const m = source.match(/\b1\.(?:\d|[12]\d|30)(?:\.\d{1,2})?\b/);
    if (m) return m[0];
  }
  return null;
}

/** libraries/<group path>/<artifact>/<version>/ 形式的加载器版本探测 */
function detectLibraryVersion(dir: string, groupPath: string, artifact: string): string | null {
  const base = join(dir, 'libraries', groupPath, artifact);
  if (!existsSync(base)) return null;
  try {
    const versions = readdirSync(base)
      .filter((name) => {
        try {
          return statSync(join(base, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    return versions[versions.length - 1] ?? null; // 多个安装时取最新
  } catch {
    return null;
  }
}

interface TypeDetection {
  type: string;
  mc_version: string | null;
  loader_version: string | null;
}

function detectTypeAndVersion(dir: string): TypeDetection {
  let rootJars: string[] = [];
  try {
    rootJars = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    /* 目录不可读：后续探测自然失败 */
  }
  const jarsText = rootJars.join('\n');
  const logText = readLatestLog(dir);

  // ---- 模组端：Forge / NeoForge / Fabric / Quilt ----
  const forgeLib = detectLibraryVersion(dir, join('net', 'minecraftforge'), 'forge');
  const neoforgeLib = detectLibraryVersion(dir, join('net', 'neoforged'), 'neoforge');
  const fabricLoaderLib = detectLibraryVersion(dir, join('net', 'fabricmc'), 'fabric-loader');
  const quiltLoaderLib = detectLibraryVersion(dir, join('org', 'quiltmc'), 'quilt-loader');

  if (/^neoforge[-_.]/im.test(jarsText) || neoforgeLib) {
    // 注意：neoforge 库版本号形如 21.1.57（不含 MC 版本，且会被 1.x 正则误读出「1.57」），
    // 游戏版本只能从根 jar 名 / 日志中取；loader_version 用 libraries 目录名。
    return {
      type: 'neoforge',
      loader_version: neoforgeLib,
      mc_version: extractMcVersion(jarsText, logText),
    };
  }
  if (/^forge[-_.]/im.test(jarsText) || forgeLib) {
    return {
      type: 'forge',
      loader_version: forgeLib,
      mc_version: extractMcVersion(forgeLib, jarsText, logText),
    };
  }
  if (/^fabric[-_]/im.test(jarsText) || fabricLoaderLib) {
    return {
      type: 'fabric',
      loader_version: fabricLoaderLib,
      mc_version: extractMcVersion(jarsText, logText),
    };
  }
  if (/^quilt[-_]/im.test(jarsText) || quiltLoaderLib) {
    return {
      type: 'quilt',
      loader_version: quiltLoaderLib,
      mc_version: extractMcVersion(jarsText, logText),
    };
  }

  // ---- Bukkit 系：Paper / Purpur / Folia / Spigot / CraftBukkit ----
  const coreMatch = rootJars.find((f) =>
    /^(paper(-clip)?|paperclip|purpur|folia|spigot|craftbukkit)[-_.]/i.test(f),
  );
  if (coreMatch) {
    const lower = coreMatch.toLowerCase();
    const type = lower.startsWith('paperclip')
      ? 'paper'
      : lower.startsWith('paper')
        ? 'paper'
        : lower.startsWith('purpur')
          ? 'purpur'
          : lower.startsWith('folia')
            ? 'folia'
            : lower.startsWith('spigot')
              ? 'spigot'
              : 'craftbukkit';
    return {
      type,
      loader_version: coreMatch,
      mc_version: extractMcVersion(coreMatch, logText),
    };
  }

  // ---- Vanilla 官方端 ----
  const vanillaJar = rootJars.find((f) => /^minecraft_server([.\-][\w.]+)?\.jar$/i.test(f));
  if (vanillaJar) {
    return {
      type: 'vanilla',
      loader_version: vanillaJar,
      mc_version: extractMcVersion(vanillaJar, readVersionJson(dir), logText),
    };
  }

  // ---- 有 plugins/mods 但认不出核心：按目录形态归类 ----
  if (hasJarsIn(dir, 'plugins')) {
    return { type: 'bukkit', mc_version: extractMcVersion(logText), loader_version: null };
  }
  if (hasJarsIn(dir, 'mods')) {
    return { type: 'forge', mc_version: extractMcVersion(logText), loader_version: null };
  }
  return { type: 'unknown', mc_version: extractMcVersion(logText), loader_version: null };
}

function hasJarsIn(dir: string, sub: string): boolean {
  const target = join(dir, sub);
  if (!existsSync(target)) return false;
  try {
    return readdirSync(target).some((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return false;
  }
}

function readLatestLog(dir: string): string | null {
  // latest.log 可能很大（几百 MB）：只读头部与尾部各一段用于版本识别
  try {
    const file = join(dir, 'logs', 'latest.log');
    if (!existsSync(file)) return null;
    const { size } = statSync(file);
    const windowSize = Math.min(size, 256 * 1024);
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(windowSize);
      const headLen = windowSize >> 1;
      readSync(fd, buf, 0, headLen, 0);
      const tailLen = windowSize - headLen;
      if (tailLen > 0 && size > headLen) {
        readSync(fd, buf, headLen, tailLen, size - tailLen);
      }
      return buf.toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readVersionJson(dir: string): string | null {
  try {
    const file = join(dir, 'version.json');
    if (!existsSync(file)) return null;
    const json = JSON.parse(readFileSync(file, 'utf-8')) as { id?: string };
    return typeof json.id === 'string' ? json.id : null;
  } catch {
    return null;
  }
}

// ===== 插件 / 模组扫描 =====

async function scanPackages(dir: string, sub: string): Promise<McPackageEntry[]> {
  const target = join(dir, sub);
  if (!existsSync(target)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(target).filter((f) => f.toLowerCase().endsWith('.jar'));
  } catch {
    return [];
  }
  files.sort((a, b) => a.localeCompare(b));
  const results: McPackageEntry[] = [];
  for (const file of files) {
    if (results.length >= MAX_PACKAGES) break;
    const base: McPackageEntry = { name: file.replace(/\.jar$/i, ''), file, version: null };
    try {
      const jar = await JarFile.open(join(target, file));
      try {
        const meta = await readJarMeta(jar);
        if (meta.name) base.name = meta.name;
        if (meta.version) base.version = meta.version;
        if (meta.depends?.length) base.depends = meta.depends;
      } finally {
        await jar.close();
      }
    } catch {
      // 非 zip / 损坏 jar：保留文件名兜底
    }
    results.push(base);
  }
  return results;
}

// ===== 对外 API =====

/** 进程内缓存（同目录短时间内重复扫描直接命中；保存/清除配置时失效） */
let cache: { dir: string; at: number; info: McServerInfo } | null = null;
const CACHE_TTL_MS = 30_000;

/**
 * 扫描指定目录的 MC 服务器信息。
 * 校验：目录存在且能看出是 MC 服务器（plugins/mods/libraries/version.json/latest.log/核心 jar 至少其一）。
 */
export async function scanMcServer(dir: string): Promise<McServerInfo> {
  const abs = String(dir ?? '').trim();
  if (!abs) throw new McServerError('服务器目录不能为空');
  let resolved: string;
  try {
    resolved = resolve(abs);
  } catch {
    throw new McServerError(`无效的服务器目录：${abs}`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new McServerError(`目录不存在：${resolved}`);
  }
  const now = Date.now();
  if (cache && cache.dir === resolved && now - cache.at < CACHE_TTL_MS) return cache.info;

  const detection = detectTypeAndVersion(resolved);
  const looksLikeServer =
    detection.type !== 'unknown' ||
    hasJarsIn(resolved, 'plugins') ||
    hasJarsIn(resolved, 'mods') ||
    existsSync(join(resolved, 'libraries')) ||
    existsSync(join(resolved, 'version.json')) ||
    existsSync(join(resolved, 'eula.txt'));
  if (!looksLikeServer) {
    throw new McServerError(
      '该目录看起来不像 Minecraft 服务器（未找到 plugins/mods/libraries/核心 jar 等特征）',
    );
  }

  const isBukkitFamily = ['paper', 'purpur', 'folia', 'spigot', 'craftbukkit', 'bukkit'].includes(
    detection.type,
  );
  const info: McServerInfo = {
    dir: resolved,
    type: detection.type,
    label: SERVER_TYPES[detection.type] ?? detection.type,
    mc_version: detection.mc_version,
    loader_version: detection.loader_version,
    plugins: isBukkitFamily ? await scanPackages(resolved, 'plugins') : [],
    mods: isBukkitFamily ? [] : await scanPackages(resolved, 'mods'),
    scanned_at: new Date().toISOString(),
  };
  cache = { dir: resolved, at: now, info };
  return info;
}

/** 当前配置的目标服务器目录（未设置为空字符串） */
export function getMcServerDir(): string {
  return config.mc_server_dir ?? '';
}

/** 设置并扫描目标服务器目录（校验通过后落盘，立即生效） */
export async function setMcServerDir(dir: string): Promise<McServerInfo> {
  const info = await scanMcServer(dir);
  saveConfig({ mc_server_dir: info.dir });
  return info;
}

/** 清除目标服务器目录设置 */
export function clearMcServerDir(): void {
  saveConfig({ mc_server_dir: '' });
  cache = null;
}

/** 当前目标服务器信息（未设置或目录已失效返回 null） */
export async function getMcServerInfo(): Promise<McServerInfo | null> {
  const dir = getMcServerDir();
  if (!dir || !existsSync(dir)) return null;
  try {
    return await scanMcServer(dir);
  } catch {
    return null;
  }
}

/**
 * 渲染注入 AI 提示词的目标服务器上下文。
 * 列表截断到 40 条（足够 AI 了解生态），依赖关系保留前几个。
 */
export function renderMcServerContext(info: McServerInfo | null): string {
  if (!info) return '未指定目标服务器。不要假设服务端类型与已装插件/模组；涉及集成需求时先向用户确认运行环境。';
  const lines: string[] = [];
  const versionText = [info.label, info.mc_version].filter(Boolean).join(' ');
  lines.push(`- 服务端：${versionText}${info.loader_version ? `（${info.loader_version}）` : ''}`);
  lines.push(`- 服务器目录（只读）：${info.dir}`);
  if (info.plugins.length) {
    lines.push(`- 已装插件（${info.plugins.length} 个）：${formatEntries(info.plugins)}`);
  }
  if (info.mods.length) {
    lines.push(`- 已装模组（${info.mods.length} 个）：${formatEntries(info.mods)}`);
  }
  if (!info.plugins.length && !info.mods.length) {
    lines.push('- 未发现已装插件/模组');
  }
  return lines.join('\n');
}

function formatEntries(entries: McPackageEntry[]): string {
  const render = (e: McPackageEntry) =>
    e.version ? `${e.name} ${e.version}` : e.name;
  const shown = entries.slice(0, 40).map(render).join('、');
  return entries.length > 40 ? `${shown} 等共 ${entries.length} 个` : shown;
}

// ===== 原生目录选择（后端在本机弹出系统「选择文件夹」窗口，前端无需手输路径） =====

const PICK_TITLE = '选择 Minecraft 服务器目录';

/** 单次子进程运行结果；launched=false 表示命令不存在/无法启动 */
interface PickerRun {
  launched: boolean;
  code: number | null;
  stdout: string;
}

/**
 * 异步运行选择器命令。不用 spawnSync：用户可能在窗口前停留几分钟，
 * 阻塞式等待会卡死整个 HTTP 服务。
 */
function runPicker(command: string, args: string[]): Promise<PickerRun> {
  return new Promise((resolvePick) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolvePick({ launched: false, code: null, stdout: '' });
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', () => resolvePick({ launched: false, code: null, stdout: '' }));
    child.on('close', (code) => resolvePick({ launched: true, code, stdout: out }));
  });
}

/** 归一化选择结果：空输出视为取消（各平台取消时都不打印路径） */
function normalizePickedDir(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed || null;
}

async function doPick(): Promise<string | null> {
  if (process.platform === 'darwin') {
    // Finder 原生选择框；取消时非零退出且无输出
    const res = await runPicker(
      'osascript',
      ['-e', `POSIX path of (choose folder with prompt "${PICK_TITLE}")`],
    );
    if (!res.launched) throw new McServerError('无法打开系统目录选择窗口');
    return normalizePickedDir(res.stdout);
  }
  if (process.platform === 'win32') {
    // PowerShell + WinForms FolderBrowserDialog（-STA 为对话框必需）
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${PICK_TITLE}'`,
      '$d.ShowNewFolderButton = $false',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
    ].join('; ');
    const res = await runPicker('powershell', ['-NoProfile', '-STA', '-Command', script]);
    if (!res.launched) throw new McServerError('无法打开系统目录选择窗口');
    return normalizePickedDir(res.stdout);
  }
  // Linux / 其他：优先 zenity，回退 kdialog
  const zenity = await runPicker('zenity', [
    '--file-selection',
    '--directory',
    '--title',
    PICK_TITLE,
  ]);
  if (zenity.launched) return normalizePickedDir(zenity.stdout);
  const kdialog = await runPicker('kdialog', [
    '--getexistingdirectory',
    homedir(),
    '--title',
    PICK_TITLE,
  ]);
  if (kdialog.launched) return normalizePickedDir(kdialog.stdout);
  throw new McServerError('未找到系统目录选择工具（需要 zenity 或 kdialog），请手动输入路径');
}

/** 进行中的弹窗会话：并发请求（多标签页/重复点击）共享同一个窗口与结果 */
let picking: Promise<string | null> | null = null;

/**
 * 弹出系统原生「选择文件夹」窗口，返回所选目录绝对路径；
 * 用户取消返回 null；平台无可用实现时抛 McServerError。
 */
export function pickMcServerDir(): Promise<string | null> {
  if (!picking) {
    picking = doPick().finally(() => {
      picking = null;
    });
  }
  return picking;
}
