/**
 * 机械校验失败修复闭环测试：
 * - validationFixIssues：把校验失败步骤转为 AI 可修复的问题单（排除环境类）
 * - 环境未就绪只产生 env 失败步骤（非代码问题，AI 不可修复）
 */
import { describe, expect, test } from 'bun:test';
import { validationFixIssues } from '../src/studio/validation';
import type { ValidationRun } from '../src/core/types';

function run(steps: ValidationRun['steps']): ValidationRun {
  return {
    id: 'run-1',
    status: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
    steps,
    started_at: new Date(0).toISOString(),
    finished_at: new Date(0).toISOString(),
  };
}

describe('validationFixIssues', () => {
  test('代码类失败步骤转为 must_fix 问题单（提供修复条件）', () => {
    const issues = validationFixIssues(
      run([
        { id: 'ruff', name: 'Ruff 检查', status: 'failed', message: '导入顺序错误', duration_ms: 0 },
        { id: 'tests', name: '草稿自带测试', status: 'failed', message: '1 个测试失败', detail: 'assert 0', duration_ms: 0 },
        { id: 'manifest', name: '清单校验', status: 'passed', duration_ms: 0 },
      ]),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]!.severity).toBe('must_fix');
    expect(issues[0]!.title).toContain('Ruff 检查');
    expect(issues[0]!.detail).toContain('导入顺序错误');
    expect(issues[1]!.detail).toContain('1 个测试失败');
    expect(issues[1]!.detail).toContain('assert 0');
  });

  test('环境类失败步骤（env）被排除：AI 无法修复基础设施问题', () => {
    const issues = validationFixIssues(
      run([
        { id: 'env', name: '测试环境', status: 'failed', message: 'UniBot 测试环境未就绪', duration_ms: 0 },
      ]),
    );
    expect(issues).toEqual([]);
  });

  test('中断类失败步骤（interrupted，服务重启遗留）被排除：重新校验即可，无需 AI 修', () => {
    const issues = validationFixIssues(
      run([
        { id: 'interrupted', name: '机械校验', status: 'failed', message: '机械校验因服务重启中断', duration_ms: 0 },
      ]),
    );
    expect(issues).toEqual([]);
  });

  test('全部失败均为环境问题时返回空数组（调用方引导同步测试环境）', () => {
    const issues = validationFixIssues(
      run([
        { id: 'env', name: '测试环境', status: 'failed', message: '未就绪', duration_ms: 0 },
        { id: 'syntax', name: '语法检查', status: 'failed', duration_ms: 0 },
      ]),
    );
    // 只有 env 失败时为空；混入代码类失败则仍可修代码
    expect(validationFixIssues(run([{ id: 'env', name: '测试环境', status: 'failed', message: '未就绪', duration_ms: 0 }]))).toEqual([]);
    expect(issues.some((i) => i.title.includes('语法检查'))).toBe(true);
  });

  test('无失败步骤返回空数组', () => {
    expect(validationFixIssues(run([{ id: 'manifest', name: '清单校验', status: 'passed', duration_ms: 0 }]))).toEqual([]);
  });
});
