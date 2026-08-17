/**
 * 平台认证：HMAC 签名 token 的签发与校验（密钥持久化，后端重启后已签发 token 仍有效）。
 *
 * 独立成模块避免循环依赖：index.ts（REST 认证）与 opencode.ts（为测试工具插件
 * 签发内部调用 token）都需要签发/校验，而 opencode.ts 不能反向 import index.ts。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function signTokenPayload(payload: string): string {
  return createHmac('sha256', config.auth.token_secret).update(payload).digest('base64url');
}

/** 签发 token（默认 30 天；插件内部调用可用更长 TTL） */
export function issueToken(ttlMs = DEFAULT_TTL_MS): string {
  const payload = Buffer.from(
    JSON.stringify({ iat: Date.now(), exp: Date.now() + ttlMs }),
  ).toString('base64url');
  return `${payload}.${signTokenPayload(payload)}`;
}

/** 校验 token 签名与有效期 */
export function verifyToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts as [string, string];
  const expected = Buffer.from(signTokenPayload(payload));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number;
    };
    return typeof data.exp === 'number' && data.exp >= Date.now();
  } catch {
    return false;
  }
}
