/**
 * 轻量结构化日志：统一时间戳 + 级别 + 模块 + 消息，支持附加结构化数据。
 * 级别通过 UNIBOT_STUDIO_LOG_LEVEL 环境变量控制（默认 info）。
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (process.env.UNIBOT_STUDIO_LOG_LEVEL as LogLevel) ?? 'info';

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function format(level: LogLevel, scope: string, message: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  return `[${ts}] [${level.toUpperCase()}] [${scope}] ${message}${suffix}`;
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown) {
  if (!enabled(level)) return;
  const line = format(level, scope, message, extra);
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
