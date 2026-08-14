/**
 * 自动调试编排（对应 Plan.md 3.5 与状态模型）：
 * - 调试阶段消费审核问题单（must_fix）修改草稿
 * - 每轮记录调试前/后文件摘要，用于无进展检测
 * - 默认最多 3 轮；连续两轮无进展时熔断置为 failed，停止自动修改
 * - 调试完成后由事件层触发重新校验与复核（见 events.ts）
 */
import { computeRevision, draftWorkspace, readDraft, updateDraft } from './drafts';
import { opencode } from './opencode';
import { config } from './config';
import { trackSession } from './sessions';
import { logger } from './logger';
import type { ReviewIssue, ReviewResult } from './types';

const DEBUG_SYSTEM_PROMPT = `你是 UniBot 扩展修复工程师。根据审核问题单修改草稿扩展。
约束：
- 只能修改草稿工作区内的文件
- 只修复问题单中列出的问题，不擅自重构或新增功能
- 修复后重新运行相关测试（如存在 tests/）
- 完成后用简短中文总结修改内容`;

export interface DebugOutcome {
  /** 本轮是否有文件变化（无进展检测依据） */
  changed: boolean;
  /** 是否触发熔断（连续两轮无进展或超出轮次） */
  fatal: boolean;
  review: ReviewResult;
}

/** 审核轮次记录（持久化到 draft.review.rounds，用于无进展熔断） */
export interface ReviewRound {
  round: number;
  /** 调试开始前的文件摘要 */
  revision_before: string;
  /** 调试结束后的文件摘要（settle 时回填） */
  revision_after?: string;
  must_fix_count: number;
}

function mustFixIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter((i) => i.severity === 'must_fix');
}

/**
 * 启动自动调试：根据审核问题单让主会话修复。
 * 校验失败后的自动修复（repairing）也走此入口，按失败摘要构造问题单。
 */
export async function startDebugging(
  draftId: string,
  issues: ReviewIssue[] | null = null,
  kind: 'review' | 'validation' = 'review',
): Promise<ReviewResult> {
  const draft = readDraft(draftId);
  const review = draft.review;
  const maxRounds = config.defaults.max_review_rounds;

  // 从调用方传入的问题单，或草稿现有审核问题单
  let mustFix: ReviewIssue[];
  if (issues) {
    mustFix = issues.filter((i) => i.severity === 'must_fix');
  } else {
    if (!review) throw new Error('无审核结果可调试');
    mustFix = mustFixIssues(review.issues);
  }

  if (kind === 'review') {
    const round = review!.round;
    if (round >= maxRounds) {
      updateDraft(draftId, { status: 'failed', error: `自动调试已超过 ${maxRounds} 轮上限` });
      logger.warn('review', '超出调试轮次上限，草稿置为 failed', { draft_id: draftId, round, max_rounds: maxRounds });
      throw new Error('已达到最大调试轮次，请在平台补充需求或重新生成');
    }
  }

  if (mustFix.length === 0) {
    updateDraft(draftId, { status: 'ready' });
    return review!;
  }

  const prevRevision = computeRevision(draftId);
  const client = opencode.getClient();
  const workspace = draftWorkspace(draftId);

  // 复用生成会话或创建调试会话
  let sessionId = draft.session_id;
  if (!sessionId) {
    const created = await client.session.create({
      body: { title: `调试：${draft.extension_id}`, parentID: undefined },
      query: { directory: workspace },
    });
    sessionId = created.data?.id ?? null;
    if (!sessionId) throw new Error('创建调试会话失败');
    trackSession(draftId, sessionId);
  }

  const status: 'repairing' | 'debugging' = kind === 'validation' ? 'repairing' : 'debugging';
  updateDraft(draftId, { status, session_id: sessionId });
  logger.info('debug', `开始自动${kind === 'validation' ? '修复' : '调试'}`, {
    draft_id: draftId,
    extension_id: draft.extension_id,
    round: kind === 'review' ? review!.round + 1 : undefined,
    max_rounds: maxRounds,
    must_fix: mustFix.length,
    session_id: sessionId,
  });

  const round = kind === 'review' ? review!.round + 1 : 1;
  const issueList = mustFix
    .map((i) => `- [${i.severity}] ${i.title}（${i.file ?? '未知文件'}）\n  ${i.detail}\n  建议：${i.suggestion ?? '无'}`)
    .join('\n');
  const prompt = `请修复以下${kind === 'validation' ? '校验' : '审核'}问题（第 ${round} 轮）：\n\n${issueList}\n\n修复完成后简要说明改动。`;

  await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text: prompt }],
      system: DEBUG_SYSTEM_PROMPT,
    },
    query: { directory: workspace },
  });

  // 记录本轮调试前摘要（持久化，用于无进展熔断）
  if (review) {
    const rounds: ReviewRound[] = [
      ...(review.rounds ?? []),
      { round, revision_before: prevRevision, must_fix_count: mustFix.length },
    ];
    updateDraft(draftId, {
      review: { ...review, round, rounds, updated_at: new Date().toISOString() },
    });
  }

  return review ?? {
    round,
    max_rounds: maxRounds,
    status: 'needs_confirmation',
    issues: [],
    summary: '修复进行中…',
    rounds: [],
    updated_at: new Date().toISOString(),
  };
}

/**
 * 调试会话完成后结算：比对文件摘要判断是否有进展。
 * - 连续两轮无进展 → failed（熔断，不再自动修改）
 * - 有进展 → 返回 changed=true，由事件层触发重新校验与复核
 */
export async function settleDebugging(draftId: string): Promise<DebugOutcome> {
  const draft = readDraft(draftId);
  const review = draft.review;
  const current = computeRevision(draftId);

  if (!review?.rounds?.length) {
    // 无轮次记录（校验失败修复场景）：一律视为有进展，重新校验
    return { changed: true, fatal: false, review: review ?? fallbackReview(draftId) };
  }

  const lastRound = review.rounds[review.rounds.length - 1]!;
  const changed = current !== lastRound.revision_before;
  const rounds: ReviewRound[] = review.rounds.map((r, i) =>
    i === review.rounds.length - 1 ? { ...r, revision_after: current } : r,
  );

  // 连续两轮无进展 → 熔断
  const consecutiveNoProgress =
    rounds.length >= 2 &&
    rounds.slice(-2).every(
      (r) => r.revision_after && r.revision_after === r.revision_before,
    );

  if (consecutiveNoProgress) {
    updateDraft(draftId, {
      status: 'failed',
      error: '自动调试连续两轮无进展，已停止修改。请补充需求或重新生成。',
      review: { ...review, rounds, status: 'failed', updated_at: new Date().toISOString() },
    });
    logger.warn('debug', '连续两轮无进展，自动调试熔断', { draft_id: draftId, rounds: rounds.length });
    return { changed: false, fatal: true, review: { ...review, rounds, status: 'failed' } };
  }

  // 有进展：回到 checking，由事件层自动重新校验 → 复核
  updateDraft(draftId, {
    status: 'checking',
    review: { ...review, rounds, updated_at: new Date().toISOString() },
  });
  logger.info('debug', '调试完成（有进展），准备重新校验', {
    draft_id: draftId,
    extension_id: draft.extension_id,
    round: rounds.length,
    changed,
  });
  return { changed, fatal: false, review: { ...review, rounds } };
}

function fallbackReview(draftId: string): ReviewResult {
  return {
    round: 0,
    max_rounds: config.defaults.max_review_rounds,
    status: 'needs_confirmation',
    issues: [],
    summary: '修复进行中…',
    rounds: [],
    updated_at: new Date().toISOString(),
  };
}
