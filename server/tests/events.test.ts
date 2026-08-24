/**
 * 会话异常终止检测测试：decideReconcile 纯函数的各分支决策。
 *
 * 对应「oc 会话异常终止总是检测不到 → 前端一直转圈圈」修复：
 * - 会话不在 /session/status 状态表（opencode 重启/会话消失）→ 连续计数后结算
 * - opencode 不可用 → 连续计数后结算
 * - busy/retry 长时间无事件（僵尸运行）→ 看门狗结算
 * - idle → 正常结算；运行中有活动 → 观望
 */
import { describe, expect, test } from 'bun:test';
import { decideReconcile, SESSION_MISS_ROUNDS } from '../src/opencode/events';

const NOW = 1_700_000_000_000;
const STALL_MS = 1_200_000; // 20 分钟

function decide(partial: Partial<Parameters<typeof decideReconcile>[0]>) {
  return decideReconcile({
    probe: { kind: 'idle' },
    misses: 0,
    last_activity: null,
    status_updated_at: NOW,
    now: NOW,
    stall_timeout_ms: STALL_MS,
    ...partial,
  });
}

describe('decideReconcile：idle', () => {
  test('状态表显示空闲 → 正常结算', () => {
    expect(decide({ probe: { kind: 'idle' } })).toEqual({ action: 'settle-idle' });
  });
});

describe('decideReconcile：会话不在状态表（opencode 重启/会话消失）', () => {
  test('前 N-1 轮只计数', () => {
    for (let misses = 0; misses < SESSION_MISS_ROUNDS - 1; misses++) {
      const d = decide({ probe: { kind: 'missing' }, misses });
      expect(d.action).toBe('count-miss');
      expect(d).toEqual({ action: 'count-miss', misses: misses + 1 });
    }
  });

  test('连续第 N 轮仍缺失 → 判定异常终止', () => {
    const d = decide({ probe: { kind: 'missing' }, misses: SESSION_MISS_ROUNDS - 1 });
    expect(d.action).toBe('settle-interrupted');
    expect((d as { reason: string }).reason).toContain('会话已不存在');
  });

  test('缺失计数不因最后活动时间新鲜而豁免（idle 事件不会再来）', () => {
    const d = decide({
      probe: { kind: 'missing' },
      misses: SESSION_MISS_ROUNDS - 1,
      last_activity: NOW,
    });
    expect(d.action).toBe('settle-interrupted');
  });
});

describe('decideReconcile：opencode 不可用', () => {
  test('连续计数达到阈值 → 判定异常终止（文案区分服务不可用）', () => {
    const d = decide({ probe: { kind: 'unreachable' }, misses: SESSION_MISS_ROUNDS - 1 });
    expect(d.action).toBe('settle-interrupted');
    expect((d as { reason: string }).reason).toContain('OpenCode 服务不可用');
  });

  test('单次不可用只计数（瞬时故障不误判）', () => {
    expect(decide({ probe: { kind: 'unreachable' }, misses: 0 })).toEqual({
      action: 'count-miss',
      misses: 1,
    });
  });
});

describe('decideReconcile：busy/retry 运行中（僵尸看门狗）', () => {
  test('近期有活动 → 观望', () => {
    const d = decide({
      probe: { kind: 'running' },
      last_activity: NOW - 60_000,
      status_updated_at: NOW - STALL_MS,
    });
    expect(d).toEqual({ action: 'none' });
  });

  test('无活动超过阈值 → 判定异常终止', () => {
    const d = decide({
      probe: { kind: 'running' },
      last_activity: NOW - STALL_MS - 1,
      status_updated_at: NOW - STALL_MS - 1,
    });
    expect(d.action).toBe('settle-interrupted');
    expect((d as { reason: string }).reason).toContain('无任何输出或事件');
  });

  test('活动时间缺失时以「进入运行态」时间为基线（promptAsync 失败/事件全丢兜底）', () => {
    const d = decide({
      probe: { kind: 'running' },
      last_activity: null,
      status_updated_at: NOW - STALL_MS - 1,
    });
    expect(d.action).toBe('settle-interrupted');
  });

  test('事件活动时间早于进入运行态时取较新者（新一轮运行刚开始）', () => {
    const d = decide({
      probe: { kind: 'running' },
      last_activity: NOW - STALL_MS - 100_000, // 上一轮的陈旧事件
      status_updated_at: NOW - 1_000,          // 刚进入运行态
    });
    expect(d).toEqual({ action: 'none' });
  });

  test('时间戳不可解析 → 按当前时间处理，不误判', () => {
    const d = decide({
      probe: { kind: 'running' },
      last_activity: null,
      status_updated_at: Number.NaN,
    });
    expect(d).toEqual({ action: 'none' });
  });

  test('运行中重置缺失计数语义：missing 后恢复 running 不再累积（由调用方清零）', () => {
    // running 分支不读 misses，确保计数清零由 reconcile 适配层负责
    const d = decide({ probe: { kind: 'running' }, misses: SESSION_MISS_ROUNDS - 1 });
    expect(d).toEqual({ action: 'none' });
  });
});
