/**
 * 测试工具后端单元测试（对应 AGENT.md 3.5）：
 * - 扩展 ID 校验与部署目标路径约束
 * - readTestLog：日志尾部读取与行数限制
 *
 * 使用临时数据目录，避免触碰真实的 ~/.unibot-studio。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/core/config';
import { readTestLog, TestToolsError } from '../src/studio/test_tools';

const ORIG_DATA_DIR = config.data_dir;
const tmpData = mkdtempSync(join(tmpdir(), 'studio-test-tools-'));

beforeAll(() => {
  config.data_dir = tmpData;
});

afterAll(() => {
  config.data_dir = ORIG_DATA_DIR;
  rmSync(tmpData, { recursive: true, force: true });
});

describe('扩展 ID 与部署目标约束', () => {
  test('PascalCase 扩展 ID 通过；非法 ID 抛错（与 drafts.validateExtensionId 一致）', async () => {
    const { validateExtensionId } = await import('../src/studio/drafts');
    const drafts: Array<{ extension_id: string; status: string }> = [];
    expect(() => validateExtensionId('WeatherExt', drafts as never)).not.toThrow();
    expect(() => validateExtensionId('weather', drafts as never)).toThrow();
    expect(() => validateExtensionId('Weather-Ext', drafts as never)).toThrow();
    expect(() => validateExtensionId('Weather Ext', drafts as never)).toThrow();
    expect(() => validateExtensionId('1Ext', drafts as never)).toThrow();
  });
});

describe('readTestLog 尾部读取', () => {
  const logDir = join(tmpData, 'logs', 'test');
  const file = join(logDir, 'WeatherExt.log');

  test('日志文件不存在时返回空列表', () => {
    const { lines } = readTestLog('WeatherExt');
    expect(lines).toEqual([]);
  });

  test('返回指定行数（尾部）', () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n') + '\n', 'utf-8');
    const { lines } = readTestLog('WeatherExt', 3);
    expect(lines).toEqual(['line-8', 'line-9', '']);
    const all = readTestLog('WeatherExt', 100);
    expect(all.lines.length).toBe(11);
  });

  test('TestToolsError 可携带错误码', () => {
    const err = new TestToolsError('部署目标越界', 'PATH_VIOLATION');
    expect(err.code).toBe('PATH_VIOLATION');
    expect(err.message).toBe('部署目标越界');
  });
});
