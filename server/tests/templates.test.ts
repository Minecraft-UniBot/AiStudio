/**
 * 开发模板扩展测试：清单重写、目录复制与最小脚手架生成。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { copyTree } from '../src/templates';
import { rewriteClonedManifest, scaffoldDraftWorkspace } from '../src/drafts';

function tmpdirAt(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `studio-${prefix}-`));
  return dir;
}

describe('rewriteClonedManifest', () => {
  test('用新 id/name/description/types 重写清单，并保留 random/resource 字符串', () => {
    const dir = tmpdirAt('manifest');
    try {
      writeFileSync(
        join(dir, 'Extension.toml'),
        `[manifest]\nschema_version = 1\n\n[extension]\nid = "Default"\nname = "默认模板 \\u0026 资源"\nversion = "1.0.0"\nauthor = "UniBot"\ndescription = "默认内置指令的图片模板与资源包。"\ntypes = ["template", "resources"]\n\n[compatibility]\nunibot = "*"\n\n[template.config_schema.background]\ntype = "string"\ndefault = '{{ random("Default", "Backgrounds") }}'\n`,
        'utf-8',
      );
      rewriteClonedManifest(dir, {
        extensionId: 'MyTpl',
        name: '我的模板',
        description: '自定义模板',
        types: ['template', 'resources'],
      });
      const out = readFileSync(join(dir, 'Extension.toml'), 'utf-8');
      expect(out).toContain('id = "MyTpl"');
      expect(out).toContain('name = "我的模板"');
      expect(out).toContain('description = "自定义模板"');
      expect(out).toContain('"template"');
      expect(out).toContain('"resources"');
      expect(out).toContain('version = "0.1.0"');
      // 模板中的 Jinja/random 函数内容作为字面量被保留，不能被破坏（重序列化可能改引号，语义不变）
      const doc = parseToml(out) as {
        template?: { config_schema?: { background?: { default?: string } } };
      };
      expect(doc.template?.config_schema?.background?.default).toBe(
        '{{ random("Default", "Backgrounds") }}',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('清单无法解析时回退为最小清单', () => {
    const dir = tmpdirAt('manifest-bad');
    try {
      writeFileSync(join(dir, 'Extension.toml'), '不是 [[ 合法 toml [', 'utf-8');
      rewriteClonedManifest(dir, {
        extensionId: 'Xyz',
        name: 'x',
        description: 'd',
        types: ['command'],
      });
      const out = readFileSync(join(dir, 'Extension.toml'), 'utf-8');
      expect(out).toContain('id = "Xyz"');
      expect(out).toContain('command');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('copyTree', () => {
  test('复制全部文件并跳过隐藏与缓存条目', () => {
    const src = tmpdirAt('src');
    const dest = join(src, '..', 'dest');
    rmSync(dest, { recursive: true, force: true });
    try {
      mkdirSync(join(src, 'Templates'), { recursive: true });
      writeFileSync(join(src, 'Templates', 'Base.html'), 'base', 'utf-8');
      writeFileSync(join(src, '.hidden.py'), 'x', 'utf-8');
      writeFileSync(join(src, '.gitkeep'), 'x', 'utf-8');
      mkdirSync(join(src, '__pycache__'), { recursive: true });
      writeFileSync(join(src, '__pycache__', 'c.pyc'), 'x', 'utf-8');
      copyTree(src, dest);
      expect(readFileSync(join(dest, 'Templates', 'Base.html'), 'utf-8')).toBe('base');
      // 隐藏/缓存条目被跳过
      expect(readdirSync(dest).map((n) => n)).not.toContain('.hidden.py');
      expect(readdirSync(dest).map((n) => n)).not.toContain('.gitkeep');
      expect(readdirSync(dest).map((n) => n)).not.toContain('__pycache__');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('scaffoldDraftWorkspace (minimal)', () => {
  test('生成清单 + 入口 + 占位测试', () => {
    const ws = tmpdirAt('workspace');
    try {
      scaffoldDraftWorkspace(
        ws,
        { extensionId: 'Hello', name: '你好', description: '打招呼', types: ['command'] },
        'minimal',
      );
      const toml = readFileSync(join(ws, 'Extension.toml'), 'utf-8');
      expect(toml).toContain('id = "Hello"');
      expect(toml).toContain('command');
      expect(readdirSync(join(ws, 'tests'))).toContain('test_extension.py');
      expect(readFileSync(join(ws, '__init__.py'), 'utf-8')).toContain('你好');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});