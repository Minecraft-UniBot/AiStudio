/**
 * 模板预览测试：预览渲染脚本存在性（脚本实际渲染由 UniBot venv 的 jinja2 执行，
 * 端到端渲染在 dev 环境通过真实 venv 验证；这里保证资源可定位）。
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { previewScriptPath } from '../src/core/config';

describe('模板预览脚本路径', () => {
  test('previewScriptPath 指向存在的渲染脚本', () => {
    const p = previewScriptPath();
    expect(existsSync(p), `预览脚本缺失: ${p}`).toBe(true);
    expect(statSync(p).isFile()).toBe(true);
  });
});