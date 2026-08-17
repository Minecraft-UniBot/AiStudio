/**
 * 草稿服务测试：扩展 ID 校验、类型过滤、状态守卫。
 */
import { describe, expect, test } from 'bun:test';
import { DraftError, sanitizeTypes, assertPromptable } from '../src/drafts';
import type { DraftMeta } from '../src/types';

function makeDraft(partial: Partial<DraftMeta>): DraftMeta {
  return {
    schema_version: 1,
    id: 'draft-1',
    extension_id: 'TestExt',
    name: '测试',
    description: '测试',
    types: ['command'],
    owner_id: 'admin',
    status: 'draft',
    session_id: null,
    model: null,
    agent: 'build',
    validation: null,
    validation_revision: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    published_at: null,
    ...partial,
  };
}

describe('sanitizeTypes', () => {
  test('过滤非法类型', () => {
    expect(sanitizeTypes(['command', 'renderer'])).toEqual(['command']);
  });

  test('空类型抛错', () => {
    expect(() => sanitizeTypes([])).toThrow(DraftError);
  });
});

describe('assertPromptable', () => {
  test('draft 状态允许发消息', () => {
    expect(() => assertPromptable(makeDraft({ status: 'draft' }))).not.toThrow();
  });

  test('ready 状态允许发消息', () => {
    expect(() => assertPromptable(makeDraft({ status: 'ready' }))).not.toThrow();
  });

  test('planning / coding 禁止发消息', () => {
    for (const status of ['planning', 'coding']) {
      expect(
        () => assertPromptable(makeDraft({ status: status as DraftMeta['status'] })),
        `状态 ${status} 应禁止发消息`,
      ).toThrow(DraftError);
    }
  });

  test('published 禁止发消息', () => {
    expect(() => assertPromptable(makeDraft({ status: 'published' }))).toThrow(DraftError);
  });
});
