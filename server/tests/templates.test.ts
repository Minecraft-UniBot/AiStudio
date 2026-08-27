/**
 * 开发模板扩展测试：清单重写、目录复制与统一模板脚手架生成（示例代码清理）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { copyTree } from '../src/studio/templates';
import { rewriteClonedManifest, scaffoldDraftWorkspace, hasCodeType } from '../src/studio/drafts';
import { config } from '../src/core/config';

const ORIG_DATA_DIR = config.data_dir;
let tmpData = '';

beforeAll(() => {
  tmpData = mkdtempSync(join(tmpdir(), 'studio-templates-'));
  config.data_dir = tmpData;
});

afterAll(() => {
  config.data_dir = ORIG_DATA_DIR;
  if (tmpData) rmSync(tmpData, { recursive: true, force: true });
});

/** 与官方 Extension.Example 布局一致的种子模板缓存（避免测试触网） */
function seedUnifiedTemplate(): void {
  const source = join(tmpData, 'templates', 'Example', 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'Extension.toml'),
    [
      '[manifest]',
      'schema_version = 1',
      '',
      '[extension]',
      'id = "Example"',
      'name = "示例扩展"',
      'version = "1.0.0"',
      'author = "UniBot"',
      'description = "一个演示 UniBot 扩展开发流程的示例扩展。"',
      'types = ["api", "command"]',
      '',
      '[compatibility]',
      'unibot = "*"',
      '',
      '[dependencies]',
      'extensions = []',
      'python = []',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(source, '__init__.py'), 'from .Config import ExampleConfig\n', 'utf-8');
  writeFileSync(join(source, 'Commands.py'), '# 示例指令\n', 'utf-8');
  writeFileSync(join(source, 'Config.py'), '# 示例配置\n', 'utf-8');
  writeFileSync(join(source, 'Services.py'), '# 示例服务\n', 'utf-8');
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
        template?: {
          entry?: string;
          config_schema?: { background?: { default?: string } };
        };
      };
      expect(doc.template?.config_schema?.background?.default).toBe(
        '{{ random("Default", "Backgrounds") }}',
      );
      // 无代码类型补目录声明（Loader 约定）
      expect(doc.template?.entry).toBe('Templates');
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

describe('scaffoldDraftWorkspace (统一模板)', () => {
  test('代码型：克隆统一模板并清除示例代码，写入干净入口与占位测试', () => {
    seedUnifiedTemplate();
    const ws = tmpdirAt('workspace');
    try {
      scaffoldDraftWorkspace(ws, {
        extensionId: 'Hello',
        name: '你好',
        description: '打招呼',
        types: ['command'],
      });
      // 示例代码被清除
      expect(existsSync(join(ws, 'Commands.py'))).toBe(false);
      expect(existsSync(join(ws, 'Config.py'))).toBe(false);
      expect(existsSync(join(ws, 'Services.py'))).toBe(false);
      // 清单被重写为用户信息
      const toml = readFileSync(join(ws, 'Extension.toml'), 'utf-8');
      expect(toml).toContain('id = "Hello"');
      expect(toml).toContain('command');
      expect(toml).toContain('version = "0.1.0"');
      // 入口为干净脚手架（覆盖模板示例入口），占位测试就位
      expect(readFileSync(join(ws, '__init__.py'), 'utf-8')).toContain('你好');
      expect(readdirSync(join(ws, 'tests'))).toContain('test_extension.py');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('无代码类型（模板/资源）：不留入口，建素材目录并在清单中声明', () => {
    seedUnifiedTemplate();
    const ws = tmpdirAt('workspace-assets');
    try {
      scaffoldDraftWorkspace(ws, {
        extensionId: 'ArtPack',
        name: '美术包',
        description: '模板与资源',
        types: ['template', 'resources'],
      });
      expect(existsSync(join(ws, '__init__.py'))).toBe(false);
      expect(existsSync(join(ws, 'tests'))).toBe(false);
      expect(existsSync(join(ws, 'Commands.py'))).toBe(false);
      expect(existsSync(join(ws, 'Templates'))).toBe(true);
      expect(existsSync(join(ws, 'Resources'))).toBe(true);
      const toml = readFileSync(join(ws, 'Extension.toml'), 'utf-8');
      expect(toml).toMatch(/\[template\]/);
      expect(toml).toMatch(/\[resources\]/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('代码型 + 模板组合仍生成 __init__.py', () => {
    seedUnifiedTemplate();
    const ws = tmpdirAt('workspace-mixed');
    try {
      scaffoldDraftWorkspace(ws, {
        extensionId: 'Mixed',
        name: '混合',
        description: '代码+模板',
        types: ['api', 'template'],
      });
      expect(existsSync(join(ws, '__init__.py'))).toBe(true);
      expect(existsSync(join(ws, 'Templates'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('混合扩展（command + resources）：入口与资源目录并存，清单同时声明两段', () => {
    seedUnifiedTemplate();
    const ws = tmpdirAt('workspace-hybrid');
    try {
      scaffoldDraftWorkspace(ws, {
        extensionId: 'Hybrid',
        name: '混合指令',
        description: '指令+资源',
        types: ['command', 'resources'],
      });
      // 混合扩展含代码能力：保留入口与占位测试
      expect(existsSync(join(ws, '__init__.py'))).toBe(true);
      expect(existsSync(join(ws, 'tests', 'test_extension.py'))).toBe(true);
      // 无代码部分：素材目录就位
      expect(existsSync(join(ws, 'Resources'))).toBe(true);
      const toml = readFileSync(join(ws, 'Extension.toml'), 'utf-8');
      expect(toml).toMatch(/types\s*=\s*\[\s*"command",\s*"resources"\s*\]/);
      expect(toml).toMatch(/\[resources\]/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('hasCodeType', () => {
  test('区分代码型与无代码型', () => {
    expect(hasCodeType(['command'])).toBe(true);
    expect(hasCodeType(['api', 'resources'])).toBe(true);
    expect(hasCodeType(['template', 'resources'])).toBe(false);
  });
});

function tmpdirAt(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `studio-${prefix}-`));
}
