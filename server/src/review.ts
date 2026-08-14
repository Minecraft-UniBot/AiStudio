/**
 * AI 审核编排（对应 Plan.md 3.5）：
 * - 创建独立审核会话（与生成/调试会话隔离），审核 AI 只读、不触发发布
 * - 输出结构化问题单（must_fix / suggestion / passed）
 * - 审核会话空闲后结算：无 must_fix → ready；有 must_fix → 交由调试阶段修复
 * - 调试完成后由事件层重新校验并复核（见 events.ts）
 */
import { readDraft, updateDraft, draftWorkspace } from './drafts';
import { opencode } from './opencode';
import { config } from './config';
import { trackSession } from './sessions';
import { logger } from './logger';
import { renderPromptWithSecurity } from './prompts';
import { toolsForPhase } from './tools';
import type { ReviewIssue, ReviewResult } from './types';

/** 审核阶段只读工具（对应 Plan 7.2：审核阶段禁用 edit/bash） */
const REVIEW_TOOLS = toolsForPhase('review');

/** 解析审核 AI 的结构化输出 */
function parseReviewOutput(text: string): { summary: string; issues: ReviewIssue[] } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('无 JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const issues: ReviewIssue[] = (rawIssues as Array<Record<string, unknown>>).map((i, idx) => ({
      id: `issue-${idx + 1}`,
      severity: ['must_fix', 'suggestion', 'passed'].includes(String(i.severity))
        ? (i.severity as ReviewIssue['severity'])
        : 'suggestion',
      title: String(i.title ?? '未命名问题'),
      detail: String(i.detail ?? ''),
      file: i.file ? String(i.file) : undefined,
      suggestion: i.suggestion ? String(i.suggestion) : undefined,
    }));
    return {
      summary: String(parsed.summary ?? ''),
      issues,
    };
  } catch {
    return {
      summary: '审核 AI 输出无法解析，请查看技术详情。',
      issues: [{ id: 'issue-1', severity: 'must_fix', title: '审核结果无法解析', detail: text.slice(0, 2000) }],
    };
  }
}

/** 创建独立审核会话并发送审核请求（异步，不等待完成） */
export async function startReview(draftId: string): Promise<ReviewResult> {
  const draft = readDraft(draftId);
  const client = opencode.getClient();
  const workspace = draftWorkspace(draftId);

  // 创建独立审核会话（与生成/调试会话隔离）
  const created = await client.session.create({
    body: { title: `审核：${draft.extension_id}`, parentID: undefined },
    query: { directory: workspace },
  });
  const sessionId = created.data?.id;
  if (!sessionId) throw new Error('创建审核会话失败');

  trackSession(draftId, sessionId);
  updateDraft(draftId, { status: 'reviewing', review_session_id: sessionId });
  logger.info('review', '开始 AI 审核', {
    draft_id: draftId,
    extension_id: draft.extension_id,
    review_session_id: sessionId,
    round: (draft.review?.round ?? 0) + 1,
  });

  // 收集需求、校验结果与调试轮次作为审核上下文
  const context = [
    `# 草稿 ${draft.extension_id}（${draft.name}）审核任务`,
    `## 原始需求\n${draft.description}`,
    `## 扩展类型\n${draft.types.join(', ')}`,
    draft.validation
      ? `## 最近校验结果\n${JSON.stringify(draft.validation, null, 2)}`
      : '## 校验结果\n（未执行）',
    draft.review?.rounds?.length
      ? `## 已进行的调试轮次\n${draft.review.rounds.length} 轮（最近摘要 ${draft.review.rounds[draft.review.rounds.length - 1]?.revision_after ?? '未结算'}）`
      : '',
    '请只读检查草稿工作区中的扩展代码并输出审核 JSON。',
  ].join('\n\n');

  // 审核会话只读：安全约束明确禁止修改文件（Plan 3.5：审核 AI 不拥有启用权限）
  const security = [
    '1. 本次会话为只读审核，禁止调用 edit / bash 等修改性工具。',
    `2. 可用的只读工具：${REVIEW_TOOLS.join(', ') || 'read'}。`,
    '3. 不得读取草稿工作区之外的任何文件，不得读取 .env / 凭据 / 密钥类文件。',
    '4. 你没有任何发布、启用或执行权限。',
  ].join('\n');

  await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: 'text', text: context }],
      agent: draft.agent,
      noReply: false,
      system: renderPromptWithSecurity('review', {
        user_request: draft.description,
      }, security),
    },
    query: { directory: workspace },
  });

  return {
    round: draft.review?.round ?? 0,
    max_rounds: config.defaults.max_review_rounds,
    status: 'needs_confirmation',
    issues: [],
    summary: '审核进行中…',
    rounds: draft.review?.rounds ?? [],
    updated_at: new Date().toISOString(),
  };
}

/** 记录审核结果（由事件回调在审核会话空闲后调用） */
export async function settleReview(draftId: string): Promise<ReviewResult> {
  const draft = readDraft(draftId);
  const sessionId = draft.review_session_id;
  if (!sessionId) {
    throw new Error('草稿没有审核会话');
  }
  const client = opencode.getClient();
  const workspace = draftWorkspace(draftId);

  // 拉取审核会话的最终助手消息（SDK 返回 { info: Message; parts: Part[] }[]）
  const messages = await client.session.messages({
    path: { id: sessionId },
    query: { directory: workspace },
  });
  const assistantText = (messages.data ?? [])
    .filter((m) => m.info.role === 'assistant')
    .map((m) =>
      (m.parts ?? [])
        .filter((p) => p.type === 'text' && 'text' in p)
        .map((p) => (p as { text: string }).text)
        .join('\n'),
    )
    .join('\n');

  const { summary, issues } = parseReviewOutput(assistantText);
  const mustFix = issues.filter((i) => i.severity === 'must_fix');
  const status: ReviewResult['status'] = mustFix.length === 0 ? 'passed' : 'needs_confirmation';
  const review: ReviewResult = {
    round: draft.review?.round ?? 0,
    max_rounds: config.defaults.max_review_rounds,
    status,
    issues,
    summary,
    rounds: draft.review?.rounds ?? [],
    updated_at: new Date().toISOString(),
  };
  updateDraft(draftId, {
    review,
    // 无 must_fix → 可发布；有 must_fix → 保持待调试（前端展示自动修复）
    status: status === 'passed' ? 'ready' : 'reviewing',
  });
  return review;
}

/**
 * 校验通过后的复核编排（Plan 3.5）：
 * - 启用 review 功能且尚未通过审核时，自动启动独立复核
 * - 返回是否触发了复核（调用方用于状态流转）
 */
export async function maybeReviewAfterValidation(draftId: string): Promise<boolean> {
  const draft = readDraft(draftId);
  if (draft.status !== 'ready') return false;
  if (!config.features.review) return false;
  // 已通过审核则无需复核；未审核或审核未通过（调试后）→ 自动复核
  if (draft.review && draft.review.status === 'passed') return false;
  await startReview(draftId);
  logger.info('review', '校验通过，自动启动复核', {
    draft_id: draftId,
    extension_id: draft.extension_id,
    round: (draft.review?.round ?? 0) + 1,
  });
  return true;
}
