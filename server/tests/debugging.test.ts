/**
 * 修复问题选择逻辑测试（三阶段审查的修复范围）。
 */
import { describe, expect, test } from 'bun:test';
import { selectIssues } from '../src/debugging';
import type { ReviewIssue } from '../src/types';

function issue(severity: ReviewIssue['severity'], title: string): ReviewIssue {
  return { id: `issue-${title}`, severity, title, detail: 'detail' };
}

describe('selectIssues', () => {
  const issues = [
    issue('must_fix', 'A'),
    issue('suggestion', 'B'),
    issue('suggestion', 'C'),
    issue('passed', 'D'),
  ];

  test('默认只修复 must_fix', () => {
    const selected = selectIssues(issues, false);
    expect(selected.map((i) => i.severity)).toEqual(['must_fix']);
  });

  test('include_suggestions=true 附带 suggestion', () => {
    const selected = selectIssues(issues, true);
    const severities = selected.map((i) => i.severity);
    expect(severities).toContain('must_fix');
    expect(severities).toContain('suggestion');
    expect(severities).not.toContain('passed');
  });

  test('空数组', () => {
    expect(selectIssues([], false)).toEqual([]);
    expect(selectIssues([], true)).toEqual([]);
  });
});
