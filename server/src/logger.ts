/**
 * 轻量结构化日志：统一时间戳 + 级别 + 模块 + 消息，支持附加结构化数据。
 *
 * 输出双通道：
 * - 控制台（人类可读）：本地时间、按级别着色的标签、模块与结构化字段；TTY 自动配色
 *   （NO_COLOR 关闭，UNIBOT_STUDIO_LOG_COLOR=1/0 强制开关）
 * - 文件（<数据目录>/logs/studio.log，纯文本、无 ANSI，非 JSON）：由 index.ts 启动时
 *   调用 enableFileLogging() 开启，超限自动轮转（.1）；UNIBOT_STUDIO_LOG_FILE 可改路径，
 *   设为 off / 0 / false 关闭
 *
 * 级别通过 UNIBOT_STUDIO_LOG_LEVEL 环境变量控制（debug | info | warn | error，默认 info）。
 * 附加数据渲染为 key=value（标量）/ 紧凑 JSON（嵌套），Error 与循环引用可安全序列化。
 */
import { mkdirSync, existsSync, statSync, renameSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(v: string | undefined): LogLevel {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'debug' || s === 'info' || s === 'warn' || s === 'error') return s;
  return 'info';
}

const MIN_LEVEL: LogLevel = parseLevel(process.env.UNIBOT_STUDIO_LOG_LEVEL);

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

// ===== 控制台配色 =====

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: `${ANSI.bold}${ANSI.red}`,
};

/**
 * 是否输出 ANSI 颜色：UNIBOT_STUDIO_LOG_COLOR=1/0 显式开关优先；
 * 未显式设置时 NO_COLOR 关闭（全局偏好），默认跟随 TTY。
 */
function useColor(): boolean {
  const force = process.env.UNIBOT_STUDIO_LOG_COLOR;
  if (force === '1' || force === 'true' || force === 'on') return true;
  if (force === '0' || force === 'false' || force === 'off') return false;
  if (process.env.NO_COLOR !== undefined) return false;
  return Boolean(process.stdout.isTTY);
}

// ===== 时间戳 =====

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 控制台短时间：HH:MM:SS.mmm */
function timeShort(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 文件完整时间：YYYY-MM-DD HH:MM:SS.mmm */
function timeFull(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${timeShort(d)}`;
}

// ===== 安全序列化（Error / 循环引用 / BigInt） =====

function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(v, (_key, val: unknown) => {
      if (typeof val === 'bigint') return `${val}n`;
      if (val instanceof Error) {
        const e = val as Error & { cause?: unknown };
        const out: Record<string, unknown> = { name: e.name, message: e.message };
        if (e.stack) out.stack = e.stack;
        if (e.cause !== undefined) out.cause = e.cause;
        return out;
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }) ?? String(v)
  );
}

function stringifyValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return `Error: ${v.message}`;
  return safeStringify(v);
}

/** 标量值是否需要引号包裹（含空白/等号/逗号时加引号，保证单行可读） */
function needsQuote(v: string): boolean {
  return v.length === 0 || /[\s,=]/.test(v);
}

/** 附加结构化数据 → " key=value key=value"（标量）；嵌套对象/数组 → 紧凑 JSON */
function formatFields(extra: unknown): string {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string' || typeof extra === 'number' || typeof extra === 'boolean') {
    return ` ${stringifyValue(extra)}`;
  }
  if (extra instanceof Error) return ` error=Error: ${extra.message}`;
  const entries = Object.entries(extra as Record<string, unknown>);
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    const rendered = stringifyValue(value);
    if (typeof value === 'string' && needsQuote(rendered)) {
      parts.push(`${key}="${rendered.replace(/"/g, '\\"')}"`);
    } else {
      parts.push(`${key}=${rendered}`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** 单行化：把消息/字段里的换行转义，保证一行一条日志 */
function singleLine(s: string): string {
  return s.replace(/\r?\n/g, '\\n');
}

interface LineOptions {
  fullTime: boolean;
  color: boolean;
  now: Date;
}

function formatLine(
  level: LogLevel,
  scope: string,
  message: string,
  extra: unknown,
  opts: LineOptions,
): string {
  const ts = opts.fullTime ? timeFull(opts.now) : timeShort(opts.now);
  const tag = level.toUpperCase().padEnd(5);
  const fields = formatFields(extra);
  let line: string;
  if (opts.color) {
    line =
      `${ANSI.gray}${ts}${ANSI.reset} ` +
      `${LEVEL_STYLE[level]}${tag}${ANSI.reset} ` +
      `${ANSI.dim}${scope}${ANSI.reset} ` +
      `${message}` +
      (fields ? `${ANSI.gray}${fields}${ANSI.reset}` : '');
  } else {
    line = `${ts} ${tag} ${scope} ${message}${fields}`;
  }
  return singleLine(line);
}

// ===== 文件落盘（默认 <数据目录>/logs/studio.log，20MB 轮转为 .1） =====

const MAX_LOG_BYTES = 20 * 1024 * 1024;
const ROTATE_CHECK_EVERY = 200; // 每 N 条日志检查一次大小，避免每条都 stat

let logFilePath: string | null = null;
let fileWrites = 0;

/**
 * 开启文件日志（幂等）。默认 <数据目录>/logs/studio.log；
 * 传入 path 或设置 UNIBOT_STUDIO_LOG_FILE 覆盖；off / 0 / false / none 关闭。
 * 返回最终文件路径（关闭时返回 null），供启动横幅展示。
 */
export function enableFileLogging(path?: string): string | null {
  const env = process.env.UNIBOT_STUDIO_LOG_FILE;
  // 显式传参 > 环境变量；都未提供时默认 <数据目录>/logs/studio.log
  let raw = path !== undefined ? path : env;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (['off', '0', 'false', 'none'].includes(raw.trim().toLowerCase())) {
      logFilePath = null;
      return null;
    }
  } else {
    raw = join(config.data_dir, 'logs', 'studio.log');
  }
  logFilePath = raw;
  try {
    mkdirSync(dirname(raw), { recursive: true });
  } catch {
    // 目录创建失败：降级为仅控制台
    logFilePath = null;
    return null;
  }
  return raw;
}

function maybeRotate(): void {
  if (!logFilePath) return;
  fileWrites += 1;
  if (fileWrites % ROTATE_CHECK_EVERY !== 0) return;
  try {
    const st = statSync(logFilePath);
    if (st.size < MAX_LOG_BYTES) return;
    const backup = `${logFilePath}.1`;
    if (existsSync(backup)) rmSync(backup, { force: true });
    renameSync(logFilePath, backup);
  } catch {
    // 轮转失败不影响运行
  }
}

function writeFile(line: string): void {
  if (!logFilePath) return;
  try {
    maybeRotate();
    appendFileSync(logFilePath, line + '\n', 'utf-8');
  } catch {
    // 落盘失败不影响运行（如磁盘满/权限）
  }
}

// ===== 入口 =====

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (!enabled(level)) return;
  // 同一时间点同时渲染文件行（完整时间戳、无 ANSI）与控制台行（短时间戳、按 TTY 配色）
  const now = new Date();
  writeFile(formatLine(level, scope, message, extra, { fullTime: true, color: false, now }));
  const line = formatLine(level, scope, message, extra, { fullTime: false, color: useColor(), now });
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (scope: string, message: string, extra?: unknown) => write('debug', scope, message, extra),
  info: (scope: string, message: string, extra?: unknown) => write('info', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => write('warn', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => write('error', scope, message, extra),
};
