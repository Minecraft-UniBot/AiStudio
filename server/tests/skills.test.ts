/**
 * Skill 加载测试：类型匹配、加载数量、渲染段格式。
 */
import { describe, expect, test, beforeAll } from 'bun:test';

// 与 src/skills.ts 读取同一目录（SKILLS_DIR = server/skills）
const SKILLS_DIR = new URL('../skills', import.meta.url).pathname;

// 真实文件系统：加载真实 skill 文件
import { listSkills, loadSkillsForTypes, renderSkillsSection } from '../src/ai/skills';
import type { ExtensionType } from '../src/core/types';

describe('skills 加载', () => {
  test('存在 command / api / template / resources 四个 skill 文件', () => {
    const names = listSkills();
    expect(names).toContain('command');
    expect(names).toContain('api');
    expect(names).toContain('template');
    expect(names).toContain('resources');
  });

  test('按类型匹配：command 只加载 command', () => {
    const loaded = loadSkillsForTypes(['command']);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    // command skill 内容应包含指令扩展要点
    expect(loaded.some((s) => s.includes('register_command'))).toBe(true);
  });

  test('按类型匹配：api 只加载 api', () => {
    const loaded = loadSkillsForTypes(['api']);
    expect(loaded.some((s) => s.includes('register_service'))).toBe(true);
  });

  test('多类型加载多个 skill', () => {
    const loaded = loadSkillsForTypes(['api', 'command']);
    expect(loaded.length).toBeGreaterThanOrEqual(2);
  });

  test('混合扩展：command + template 加载两个技能且含混合指导', () => {
    const loaded = loadSkillsForTypes(['command', 'template']);
    expect(loaded.some((s) => s.includes('register_command'))).toBe(true);
    expect(loaded.some((s) => s.includes('render_image'))).toBe(true);
    // template skill 覆盖混合扩展场景
    const template_skill = loaded.find((s) => s.includes('模板扩展开发'));
    expect(template_skill).toContain('混合扩展');
  });

  test('renderSkillsSection 输出包含标题', () => {
    const section = renderSkillsSection(['command']);
    expect(section).toContain('# 已加载的开发技能');
    expect(section).toContain('Skill：指令扩展开发');
  });
});
