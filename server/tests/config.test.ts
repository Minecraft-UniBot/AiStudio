/**
 * 文档/市场白名单测试：路径生成与文件存在性。
 */
import { describe, expect, test, beforeAll } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { docsAllowlistPaths, marketAllowlistPaths, marketRegistryPath } from '../src/core/config';

describe('白名单路径', () => {
  test('文档白名单包含全部 6 个文档文件', () => {
    const paths = docsAllowlistPaths();
    expect(paths.length).toBe(6);
    const names = paths.map((p) => basename(p));
    expect(names).toContain('开发插件.md');
    expect(names).toContain('扩展系统.md');
    expect(names).toContain('配置说明.md');
    expect(names).toContain('上传市场.md');
    expect(names).toContain('接口文档.md');
    expect(names).toContain('编码规范.md');
  });

  test('文档文件真实存在（供 AI 只读）', () => {
    for (const p of docsAllowlistPaths()) {
      expect(existsSync(p), `文档缺失: ${p}`).toBe(true);
    }
  });

  test('市场注册表路径存在', () => {
    const p = marketRegistryPath();
    if (!p) {
      // 独立仓库未检出 Market/（CI 由工作流检出）时，注册表为可选能力：白名单必须为空
      expect(marketAllowlistPaths()).toEqual([]);
      return;
    }
    expect(existsSync(p), `市场注册表缺失: ${p}`).toBe(true);
  });

  test('市场白名单至多一个文件', () => {
    expect(marketAllowlistPaths().length).toBeLessThanOrEqual(1);
  });
});
