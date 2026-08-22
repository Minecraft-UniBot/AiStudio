/**
 * MC 服务器扫描测试：服务端类型/版本识别、jar 内清单解析（plugin.yml / fabric.mod.json / mods.toml）、
 * 损坏 jar 兜底与提示词上下文渲染。
 *
 * jar 用手工构造的最小 ZIP（stored 条目，读取器不校验 CRC），不依赖外部 zip 工具。
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McServerError, renderMcServerContext, scanMcServer } from '../src/mc_server';

/** 构造最小合法 ZIP：stored 条目 + 中央目录 + EOCD（CRC 置 0，读取器不做完整性校验） */
function makeJar(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const data = Buffer.from(content, 'utf-8');
    // 本地文件头（30 字节固定区）
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 8); // method = stored
    lh.writeUInt32LE(data.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra len
    locals.push(lh, nameBuf, data);
    // 中央目录条目（46 字节固定区）
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    ch.writeUInt16LE(0, 10); // method
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42); // local header offset
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function newServerDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `studio-mc-${label}-`));
}

describe('scanMcServer 类型与版本识别', () => {
  test('Paper 端：根目录核心 jar + plugins 清单解析', async () => {
    const dir = newServerDir('paper');
    try {
      writeFileSync(join(dir, 'paper-1.21.4-116.jar'), '');
      mkdirSync(join(dir, 'plugins'));
      writeFileSync(
        join(dir, 'plugins', 'Vault.jar'),
        makeJar({
          'plugin.yml': [
            'name: Vault',
            'version: 1.7.3',
            "main: net.milkbowl.vault.Vault",
            'depend:',
            '- Essentials',
            '',
          ].join('\n'),
        }),
      );
      writeFileSync(
        join(dir, 'plugins', 'EssentialsX.jar'),
        makeJar({
          'plugin.yml': [
            'name: EssentialsX',
            "version: 2.20.1",
            "api-version: '1.20'",
            'softdepend: [PlaceholderAPI, Vault]',
            '',
          ].join('\n'),
        }),
      );
      // 损坏 jar：非 zip 内容，回退文件名展示且不抛错
      writeFileSync(join(dir, 'plugins', 'broken.jar'), 'this is not a zip');

      const info = await scanMcServer(dir);
      expect(info.type).toBe('paper');
      expect(info.label).toBe('Paper');
      expect(info.mc_version).toBe('1.21.4');
      expect(info.plugins).toHaveLength(3);

      const vault = info.plugins.find((p) => p.file === 'Vault.jar');
      expect(vault?.name).toBe('Vault');
      expect(vault?.version).toBe('1.7.3');
      expect(vault?.depends).toContain('Essentials');

      const essx = info.plugins.find((p) => p.file === 'EssentialsX.jar');
      expect(essx?.name).toBe('EssentialsX');
      expect(essx?.version).toBe('2.20.1');
      expect(essx?.depends).toEqual(['PlaceholderAPI', 'Vault']);

      const broken = info.plugins.find((p) => p.file === 'broken.jar');
      expect(broken?.name).toBe('broken');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Fabric 端：launch jar + libraries 加载器版本 + fabric.mod.json', async () => {
    const dir = newServerDir('fabric');
    try {
      writeFileSync(join(dir, 'fabric-server-launch.jar'), '');
      mkdirSync(join(dir, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.16.9'), {
        recursive: true,
      });
      mkdirSync(join(dir, 'logs'));
      writeFileSync(
        join(dir, 'logs', 'latest.log'),
        '[main/INFO]: Starting minecraft server version 1.21.1\n',
      );
      mkdirSync(join(dir, 'mods'));
      writeFileSync(
        join(dir, 'mods', 'sodium-fabric-mod.json.jar'),
        makeJar({
          'fabric.mod.json': JSON.stringify({
            id: 'sodium',
            name: 'Sodium',
            version: '0.5.11',
            depends: { minecraft: '1.21.x', java: '>=17', 'fabric-api': '*' },
          }),
        }),
      );

      const info = await scanMcServer(dir);
      expect(info.type).toBe('fabric');
      expect(info.loader_version).toBe('0.16.9');
      expect(info.mc_version).toBe('1.21.1');
      expect(info.plugins).toHaveLength(0);
      expect(info.mods).toHaveLength(1);
      const sodium = info.mods[0]!;
      expect(sodium.name).toBe('Sodium');
      expect(sodium.version).toBe('0.5.11');
      // minecraft/java 不算依赖生态
      expect(sodium.depends).toEqual(['fabric-api']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('NeoForge 端：库版本号不含 MC 版本时从日志取游戏版本', async () => {
    const dir = newServerDir('neoforge');
    try {
      writeFileSync(join(dir, 'neoforge-21.1.57-installer.jar'), '');
      mkdirSync(join(dir, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.57'), {
        recursive: true,
      });
      mkdirSync(join(dir, 'logs'));
      writeFileSync(
        join(dir, 'logs', 'latest.log'),
        '[main/INFO]: Starting minecraft server version 1.21.1\n',
      );
      mkdirSync(join(dir, 'mods'));
      writeFileSync(
        join(dir, 'mods', 'create.jar'),
        makeJar({
          'META-INF/neoforge.mods.toml': [
            'modLoader="javafml"',
            '[[mods]]',
            'modId="create"',
            'displayName="Create"',
            'version="${file.jarVersion}"',
            '',
          ].join('\n'),
        }),
      );

      const info = await scanMcServer(dir);
      expect(info.type).toBe('neoforge');
      expect(info.loader_version).toBe('21.1.57');
      // 回归：21.1.57 不能被误读成 MC「1.57」；真实版本来自日志
      expect(info.mc_version).toBe('1.21.1');
      const create = info.mods[0]!;
      expect(create.name).toBe('Create');
      // ${file.jarVersion} 占位符无法确定版本 → null
      expect(create.version).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Vanilla 官方端：minecraft_server.<ver>.jar', async () => {
    const dir = newServerDir('vanilla');
    try {
      writeFileSync(join(dir, 'minecraft_server.1.20.4.jar'), '');
      const info = await scanMcServer(dir);
      expect(info.type).toBe('vanilla');
      expect(info.mc_version).toBe('1.20.4');
      expect(info.plugins).toHaveLength(0);
      expect(info.mods).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('非法输入：不存在目录与非服务器目录均报错', async () => {
    await expect(scanMcServer('/nonexistent/mc-server-path')).rejects.toThrow(McServerError);
    const empty = newServerDir('empty');
    try {
      await expect(scanMcServer(empty)).rejects.toThrow(/不像 Minecraft 服务器/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('renderMcServerContext 提示词上下文', () => {
  test('未指定服务器时引导 AI 向用户确认环境', () => {
    const text = renderMcServerContext(null);
    expect(text).toContain('未指定目标服务器');
  });

  test('包含服务端类型、版本与插件列表', async () => {
    const dir = newServerDir('ctx');
    try {
      writeFileSync(join(dir, 'spigot-1.20.4.jar'), '');
      mkdirSync(join(dir, 'plugins'));
      writeFileSync(
        join(dir, 'plugins', 'Vault.jar'),
        makeJar({ 'plugin.yml': 'name: Vault\nversion: 1.7.3\n' }),
      );
      const info = await scanMcServer(dir);
      const text = renderMcServerContext(info);
      expect(text).toContain('Spigot 1.20.4');
      expect(text).toContain(`服务器目录（只读）：${info.dir}`);
      expect(text).toContain('已装插件（1 个）');
      expect(text).toContain('Vault 1.7.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
