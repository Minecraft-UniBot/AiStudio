/**
 * 插件市场上传测试：版本读取、README 生成、市场配置保存、登录态检测与并发锁。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketError,
  getMarketStatus,
  readManifestVersion,
  renderRepoReadme,
  saveMarketConfig,
  startMarketPublish,
} from '../src/studio/market';
import { writeDraft } from '../src/studio/drafts';
import { config } from '../src/core/config';
import type { DraftMeta } from '../src/core/types';

const ORIG_DATA_DIR = config.data_dir;
let tmpData = '';

beforeAll(() => {
  tmpData = mkdtempSync(join(tmpdir(), 'studio-market-'));
  config.data_dir = tmpData;
  mkdirSync(join(tmpData, 'config'), { recursive: true });
});

afterAll(() => {
  config.data_dir = ORIG_DATA_DIR;
  if (tmpData) rmSync(tmpData, { recursive: true, force: true });
});

function makeDraft(partial: Partial<DraftMeta>): DraftMeta {
  return {
    schema_version: 1,
    id: 'draft-1',
    extension_id: 'TestExt',
    name: '测试扩展',
    description: '一个用于测试的扩展',
    types: ['command'],
    owner_id: 'admin',
    status: 'ready',
    session_id: null,
    model: null,
    agent: 'build',
    validation: { id: 'v1', status: 'passed', steps: [], started_at: '', revision: 'abc' },
    validation_revision: 'abc',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
    ...partial,
  };
}

describe('readManifestVersion', () => {
  test('从 Extension.toml 读取版本号', () => {
    const ws = join(tmpData, 'ws');
    mkdirSync(join(ws, 'TestExt'), { recursive: true });
    writeFileSync(
      join(ws, 'TestExt', 'Extension.toml'),
      '[manifest]\nschema_version = 1\n\n[extension]\nid = "TestExt"\nversion = "0.3.1"\n',
      'utf-8',
    );
    expect(readManifestVersion(ws, 'TestExt')).toBe('0.3.1');
  });

  test('缺失 version 返回 null', () => {
    const ws = join(tmpData, 'ws2');
    mkdirSync(join(ws, 'TestExt'), { recursive: true });
    writeFileSync(join(ws, 'TestExt', 'Extension.toml'), '[extension]\nid = "TestExt"\n', 'utf-8');
    expect(readManifestVersion(ws, 'TestExt')).toBeNull();
  });

  test('文件不存在返回 null', () => {
    expect(readManifestVersion(join(tmpData, 'nope'), 'TestExt')).toBeNull();
  });
});

describe('renderRepoReadme', () => {
  test('包含扩展名、描述与目录结构、发布说明', () => {
    const readme = renderRepoReadme(makeDraft({}), '');
    expect(readme).toContain('# 测试扩展');
    expect(readme).toContain('一个用于测试的扩展');
    expect(readme).toContain('Extension.toml');
    expect(readme).toContain('.github/workflows/release.yml');
    expect(readme).toContain('插件市场');
  });
});

describe('saveMarketConfig', () => {
  test('保存 token / owner / 可见性并返回脱敏状态', async () => {
    const status = await saveMarketConfig({
      owner: 'TestOwner',
      token: 'ghp_testtoken1234',
      repo_visibility: 'private',
    });
    expect(status.owner).toBe('TestOwner');
    expect(status.token_configured).toBe(true);
    expect(status.token_tail).toBe('1234');
    expect(status.repo_visibility).toBe('private');
    // 明文 token 不得出现在返回中
    expect(JSON.stringify(status)).not.toContain('ghp_testtoken1234');
  });
});

describe('getMarketStatus', () => {
  test('返回完整状态对象（ready 为布尔，guidance 与 ready 互斥）', async () => {
    const status = await getMarketStatus();
    expect(typeof status.ready).toBe('boolean');
    expect(typeof status.git_configured).toBe('boolean');
    expect(typeof status.gh_available).toBe('boolean');
    expect(typeof status.gh_authed).toBe('boolean');
    expect(typeof status.token_configured).toBe('boolean');
    expect(status.market_repo).toBeTruthy();
    if (status.ready) {
      expect(status.guidance).toBeNull();
      expect(status.owner).toBeTruthy();
    } else {
      expect(status.guidance).toBeTruthy();
    }
  });
});

describe('startMarketPublish', () => {
  test('已在进行市场上传的草稿拒绝重复上传', async () => {
    const draft = makeDraft({
      id: 'busy-draft',
      market: {
        id: 'run-1',
        status: 'running',
        steps: [],
        repo: null,
        version: null,
        release_tag: null,
        release_url: null,
        pr_url: null,
        started_at: new Date().toISOString(),
      },
    });
    writeDraft(draft);
    expect(() => startMarketPublish('busy-draft')).toThrow(MarketError);
    try {
      startMarketPublish('busy-draft');
    } catch (e) {
      expect((e as MarketError).code).toBe('MARKET_BUSY');
    }
  });
});
