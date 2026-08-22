/**
 * 提示词模板测试：front-matter 解析、占位符渲染、残留清理、版本化。
 */
import { describe, expect, test } from 'bun:test';
import { renderPrompt, listPrompts, getPrompt } from '../src/ai/prompts';

describe('prompts 渲染', () => {
  test('模板存在（system / planning / scaffold / summary）', () => {
    const names = listPrompts().map((p) => p.name);
    for (const required of ['system', 'planning', 'scaffold', 'summary']) {
      expect(names).toContain(required);
    }
  });

  test('占位符替换：{{extension_id}} 等被实际值替换', () => {
    const out = renderPrompt('scaffold', {
      extension_id: 'WeatherExt',
      allowlist: '/tmp/ws',
      market_path: '/tmp/market.json',
    });
    expect(out).toContain('WeatherExt');
    expect(out).toContain('/tmp/ws');
    // 已替换的 key 不再残留
    expect(out).not.toContain('{{extension_id}}');
  });

  test('未提供的占位符被清理，不泄露模板变量', () => {
    const out = renderPrompt('scaffold', {});
    expect(out).not.toMatch(/\{\{[^}]+\}\}/);
  });

  test('system 模板包含两阶段说明与自测要求', () => {
    const out = renderPrompt('system', { allowlist: '/tmp/ws', market_path: '/tmp/market.json' });
    expect(out).toContain('规划');
    expect(out).toContain('编码');
    expect(out).toContain('unibot_deploy');
  });

  test('scaffold 模板要求编码后用测试工具自测', () => {
    const out = renderPrompt('scaffold', {
      extension_id: 'TestExt',
      allowlist: '/tmp/ws',
      market_path: '/tmp/market.json',
    });
    expect(out).toContain('unibot_deploy');
    expect(out).toContain('unibot_run_tests');
  });

  test('planning 模板要求先提问', () => {
    const out = renderPrompt('planning', {
      name: '测试',
      extension_id: 'TestExt',
      types: 'command',
      user_request: '做个测试',
      allowlist: '/tmp/ws',
      market_path: '/tmp/market.json',
      docs_path: '/tmp/docs',
    });
    expect(out).toContain('先提问澄清');
    expect(out).toContain('PLAN.md');
  });

  test('getPrompt 返回最新版本', () => {
    const latest = getPrompt('system');
    expect(latest).not.toBeNull();
    expect(latest!.version).toBeGreaterThanOrEqual(1);
    expect(latest!.content.length).toBeGreaterThan(0);
  });
});
