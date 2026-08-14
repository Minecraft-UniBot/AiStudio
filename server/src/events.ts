/**
 * 事件服务：消费 OpenCode SSE 事件流，归一化为平台自有事件，
 * 通过已认证的 WebSocket 推送给前端；并负责会话结束/错误的状态流转。
 *
 * 注意：
 * - SDK 事件结构为 { type, properties: { ... } }，所有字段在 properties 内（Plan.md 5.3）。
 * - opencode /event 必须按精确目录订阅（query.directory），否则收不到任何会话事件；
 *   因此每个草稿工作区维护一条 SSE 订阅（一条订阅覆盖该草稿的主会话与审核会话）。
 *
 * 断线重连后前端先通过 REST 恢复状态，再继续消费实时事件。
 */
import type { ServerWebSocket } from 'bun';
import { opencode } from './opencode';
import { readDraft, updateDraft } from './drafts';
import { settleDebugging } from './debugging';
import { settleReview, startReview } from './review';
import { runValidation } from './validation';
import { draftIdForSession, getWorkspaces } from './sessions';
import { logger } from './logger';
import type { PermissionRequest, QuestionRequest, StudioEvent } from './types';

const WS_CLIENTS = new Set<ServerWebSocket<unknown>>();

export function broadcast(event: StudioEvent) {
  const payload = JSON.stringify(event);
  for (const ws of WS_CLIENTS) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

export function registerSocket(ws: ServerWebSocket<unknown>) {
  WS_CLIENTS.add(ws);
}

export function unregisterSocket(ws: ServerWebSocket<unknown>) {
  WS_CLIENTS.delete(ws);
}

/** 从原始事件提取 sessionID（事件字段位于 properties 内，部分在 info/part 内） */
function rawSessionId(raw: Record<string, unknown>): string {
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  const info = props.info as Record<string, unknown> | undefined;
  const part = props.part as Record<string, unknown> | undefined;
  return String(
    props.sessionID ?? info?.sessionID ?? part?.sessionID ?? raw.sessionID ?? raw.session_id ?? '',
  );
}

function stringifyError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '未知错误';
  return JSON.stringify(value);
}

/** 归一化 OpenCode 事件（过滤到与草稿相关的部分） */
function normalize(raw: Record<string, unknown>): StudioEvent | null {
  const type = String(raw.type ?? '');
  const props = (raw.properties ?? {}) as Record<string, unknown>;
  const sessionId = rawSessionId(raw);
  if (!sessionId) return null;

  const base = { draft_id: sessionId }; // draft_id 由调用方替换

  switch (type) {
    case 'session.status': {
      // status 是 SessionStatus 联合对象：{ type: 'idle' | 'busy' | 'retry', ... }
      const statusObj = props.status as Record<string, unknown> | undefined;
      return {
        ...base,
        type: 'session.status',
        status: String(statusObj?.type ?? ''),
      };
    }
    case 'session.idle':
      return { ...base, type: 'session.idle' };
    case 'session.error':
      return { ...base, type: 'session.error', error: stringifyError(props.error) };
    case 'session.diff':
      return { ...base, type: 'session.diff' };
    case 'message.updated':
      return { ...base, type: 'message.updated', message: props.info };
    case 'message.part.updated': {
      const part = (props.part ?? {}) as Record<string, unknown>;
      return {
        ...base,
        type: 'message.part.updated',
        message_id: String(part.messageID ?? ''),
        part,
      };
    }
    case 'todo.updated':
      return { ...base, type: 'todo.updated', todo: props.todos };
    case 'permission.asked':
    case 'permission.updated': {
      // opencode 1.18.4 实际事件类型为 permission.asked（SDK 类型文件仍写 permission.updated），
      // properties 直接就是 Permission 对象：{ id, sessionID, permission, patterns[], metadata }
      const p = props as Record<string, unknown>;
      const patterns = Array.isArray(p.patterns) ? (p.patterns as unknown[]).map(String) : [];
      const metadata = (p.metadata as Record<string, unknown>) ?? {};
      const description =
        patterns.join(', ') ||
        String(metadata.filepath ?? metadata.parentDir ?? p.pattern ?? '');
      const permission: PermissionRequest = {
        id: String(p.id ?? ''),
        session_id: String(p.sessionID ?? ''),
        permission: String(p.permission ?? p.type ?? ''),
        tool_name: String(p.tool ?? p.permission ?? p.type ?? ''),
        description,
        metadata,
      };
      return { ...base, type: 'permission.asked', permission };
    }
    case 'permission.replied':
      return {
        ...base,
        type: 'permission.replied',
        permission_id: String(props.permissionID ?? ''),
      };
    case 'question.updated': {
      // 当前 SDK 版本未见 question 事件，保留防御性映射
      const q = (props.question ?? {}) as Record<string, unknown>;
      const question: QuestionRequest = {
        id: String(q.questionID ?? q.id ?? ''),
        session_id: sessionId,
        prompt: String(q.prompt ?? ''),
        choices: Array.isArray(q.choices) ? q.choices.map((c) => String(c)) : [],
        multiple: Boolean(q.multiple),
      };
      return { ...base, type: 'question.asked', question };
    }
    default:
      return null;
  }
}

let consumerStarted = false;

/**
 * 会话完成/错误后的状态流转：
 * - 主会话（生成/修复/调试）idle → generating/repairing/debugging -> draft
 * - 审核会话 idle → 结算审核结果（settleReview），通过则 ready
 * - session.error → 草稿置为 error
 */
/**
 * 修复/调试会话完成后：结算进展 → 有进展则重新校验 → 校验通过后自动复核。
 * 无进展熔断由 settleDebugging 处理（连续两轮 → failed）。
 */
async function settleAndRecheck(draftId: string, status: 'repairing' | 'debugging') {
  try {
    const outcome = await settleDebugging(draftId);
    const afterSettle = readDraft(draftId);
    if (afterSettle.status === 'failed') {
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'failed' });
      return;
    }
    if (!outcome.changed && status === 'debugging') {
      // 调试无进展但未熔断：回到 checking 等待用户决定（前端展示原因）
      broadcast({ type: 'draft.updated', draft_id: draftId, status: afterSettle.status });
      return;
    }
    // 有进展 → 重新校验 → 校验通过 → 自动复核
    const run = await runValidation(draftId);
    const post = readDraft(draftId);
    if (run.status === 'passed') {
      await startReview(draftId);
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'reviewing' });
    } else {
      broadcast({ type: 'draft.updated', draft_id: draftId, status: post.status });
    }
    broadcast({ type: 'validation.updated', draft_id: draftId, run });
  } catch (e) {
    logger.error('events', `${status} 结算失败`, { draft_id: draftId, error: (e as Error).message });
    const current = readDraft(draftId);
    if (current.status === 'checking' || current.status === 'debugging' || current.status === 'repairing') {
      updateDraft(draftId, { status: 'draft', error: (e as Error).message });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
    }
  }
}

async function settleSessionState(draftId: string, sessionId: string, ev: StudioEvent) {
  if (ev.type === 'session.error') {
    let draft;
    try {
      draft = readDraft(draftId);
    } catch {
      return; // 草稿已删除
    }
    logger.warn('draft', `会话错误，草稿置为 error`, { draft_id: draftId, extension_id: draft.extension_id, error: ev.error });
    updateDraft(draftId, { status: 'error', error: ev.error });
    broadcast({ type: 'draft.updated', draft_id: draftId, status: 'error' });
    return;
  }

  const isIdle = ev.type === 'session.idle' || (ev.type === 'session.status' && ev.status === 'idle');
  if (!isIdle) return;

  let draft;
  try {
    draft = readDraft(draftId);
  } catch {
    return; // 草稿已删除
  }

  // 主会话完成（生成 / 修复 / 调试）
  if (sessionId === draft.session_id) {
    if (draft.status === 'generating') {
      logger.info('draft', 'AI 生成完成', {
        draft_id: draftId,
        extension_id: draft.extension_id,
        session_id: sessionId,
      });
      updateDraft(draftId, { status: 'draft' });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
      return;
    }
    if (draft.status === 'repairing' || draft.status === 'debugging') {
      logger.info('draft', `AI ${draft.status === 'repairing' ? '修复' : '调试'}完成，进入结算`, {
        draft_id: draftId,
        extension_id: draft.extension_id,
        session_id: sessionId,
        status_before: draft.status,
      });
      await settleAndRecheck(draftId, draft.status);
    }
    return;
  }

  // 审核会话完成 → 结算审核结果
  if (sessionId === draft.review_session_id) {
    try {
      const result = await settleReview(draftId);
      const after = readDraft(draftId);
      logger.info('review', `审核完成`, {
        draft_id: draftId,
        extension_id: draft.extension_id,
        status: result.status,
        issues: result.issues.length,
        must_fix: result.issues.filter((i) => i.severity === 'must_fix').length,
      });
      broadcast({ type: 'review.updated', draft_id: draftId, review: result });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: after.status });
    } catch (e) {
      logger.error('review', `审核结算失败`, { draft_id: draftId, error: (e as Error).message });
    }
  }
}

// ===== 按工作区维护 SSE 订阅 =====

/** workspace 路径 -> AbortController（用于关闭订阅） */
const SUBSCRIPTIONS = new Map<string, AbortController>();

async function subscribeWorkspace(workspace: string) {
  if (SUBSCRIPTIONS.has(workspace)) return;
  const ac = new AbortController();
  SUBSCRIPTIONS.set(workspace, ac);

  const run = async () => {
    try {
      const client = opencode.getClient();
      // 必须按精确目录订阅；signal 用于草稿删除时主动关闭
      const { stream } = await client.event.subscribe({
        query: { directory: workspace },
        signal: ac.signal,
        onSseEvent: async ({ data }) => {
          if (!data || typeof data !== 'object') return;
          const raw = data as Record<string, unknown>;
          const sessionId = rawSessionId(raw);
          if (!sessionId) return;
          const draftId = draftIdForSession(sessionId);
          if (!draftId) return;
          const ev = normalize(raw);
          if (!ev) return;
          logger.debug('events', `收到事件 ${ev.type}`, { draft_id: draftId });
          await settleSessionState(draftId, sessionId, ev);
          broadcast({ ...ev, draft_id: draftId });
        },
        onSseError: (error) => {
          if (!ac.signal.aborted) {
            logger.warn('events', 'SSE 流错误（将自动重连）', {
              workspace,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
      logger.info('events', 'SSE 订阅已建立', { workspace });
      // 迭代驱动底层 fetch 流；服务端关闭后循环结束
      for await (const _ of stream) {
        // 事件已在 onSseEvent 中处理
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        logger.warn('events', 'SSE 订阅异常', { workspace, error: (e as Error).message });
      }
    } finally {
      // 仅当仍是当前控制器时才清理，避免误删新订阅
      if (SUBSCRIPTIONS.get(workspace) === ac) {
        SUBSCRIPTIONS.delete(workspace);
      }
    }
  };
  run().catch((e) => logger.error('events', 'SSE 订阅循环异常', { workspace, error: (e as Error).message }));
}

/** 协调循环：为新草稿建立订阅、为已删除草稿关闭订阅（幂等，2s 一轮） */
export async function startEventConsumer() {
  if (consumerStarted) return;
  consumerStarted = true;

  while (true) {
    const wanted = getWorkspaces();
    // 关闭已删除草稿的订阅
    for (const [workspace, ac] of SUBSCRIPTIONS) {
      if (!wanted.has(workspace)) {
        ac.abort();
        SUBSCRIPTIONS.delete(workspace);
        logger.info('events', '关闭 SSE 订阅', { workspace });
      }
    }
    // 为新工作区建立订阅
    for (const workspace of wanted) {
      subscribeWorkspace(workspace);
    }
    await Bun.sleep(2000);
  }
}
