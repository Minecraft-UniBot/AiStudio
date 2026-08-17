/**
 * Skill 加载（对应「自动加载对应的 skill」）：
 * - skills 存放 server/skills/*.md（command / api 等，按扩展类型匹配）
 * - 编码阶段根据草稿 types 自动加载匹配的 skill 内容，拼入 system 提示词
 * - skill 是开发规范/最佳实践的技能包，与 prompts 模板（任务编排）分开管理
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resSrcDir } from './config';
import type { ExtensionType } from './types';

const SKILLS_DIR = join(resSrcDir(), '..', 'skills');

/** skill 文件 front-matter 中的类型声明（如 types: command / types: api,command） */
interface SkillMeta {
  types: ExtensionType[];
}

function parseSkillFrontMatter(content: string): { meta: SkillMeta; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { meta: { types: [] }, body: content };
  const metaText = m[1] ?? '';
  const typesMatch = metaText.match(/^types:\s*(.+)$/m);
  const types = (typesMatch?.[1] ?? '')
    .split(',')
    .map((t) => t.trim() as ExtensionType)
    .filter((t) => ['api', 'command', 'renderer', 'template', 'resources'].includes(t));
  return { meta: { types }, body: (m[2] ?? '').trim() };
}

/** 列出全部可用 skill 名称 */
export function listSkills(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

/**
 * 按草稿类型加载匹配的 skill 内容（含 front-matter 声明）。
 * 一个类型可对应多个 skill 文件，全部拼入。
 */
export function loadSkillsForTypes(types: ExtensionType[]): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const loaded: string[] = [];
  for (const name of listSkills()) {
    const raw = readFileSync(join(SKILLS_DIR, `${name}.md`), 'utf-8');
    const { meta, body } = parseSkillFrontMatter(raw);
    // 未声明类型的 skill 视为通用，始终加载
    if (meta.types.length === 0 || types.some((t) => meta.types.includes(t))) {
      loaded.push(body.trim());
    }
  }
  return loaded;
}

/** 拼装 skill 段（作为 system 提示词的附录） */
export function renderSkillsSection(types: ExtensionType[]): string {
  const skills = loadSkillsForTypes(types);
  if (skills.length === 0) return '';
  return `\n\n# 已加载的开发技能（依据扩展类型自动加载，务必遵守）\n\n${skills.join('\n\n---\n\n')}`;
}
