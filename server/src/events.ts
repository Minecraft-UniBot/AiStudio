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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { opencode } from './opencode';
import { readDraft, updateDraft, draftWorkspace, listDrafts } from './drafts';
import { settleDebugging } from './debugging';
import { settleReview, startReview } from './review';
import { runValidation } from './validation';
import { startCoding } from './pipeline';
import { draftIdForSession, getWorkspaces } from './sessions';
import { logger } from './logger';
import { docsAllowlistPaths, marketAllowlistPaths, unibotEnvPython, validationScriptPath } from './config';
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

/** 展开 ~ 前缀并规范化为绝对路径（与白名单路径比较用） */
function normalizePath(value: string): string {
  const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  try {
    return resolve(expanded);
  } catch {
    return expanded;
  }
}

/**
 * 判断权限请求是否命中自动放行规则：
 * 1. web_fetch 访问 github.com（GitHub 公开仓库只读参考）→ 自动放行
 * 2. 读工作区外文档触发的是 external_directory，工作区内 read 通常已被配置放行，
 *    因此 read / external_directory 两类权限名都认，命中文档/市场白名单 → 自动放行
 * 命中的请求由后端自动放行（once），不推送到前端弹窗；
 * 其它权限（edit / bash / 白名单外路径）保持原样询问。
 */
function matchesDocsAllowlist(permission: PermissionRequest): boolean {
  const tool = (permission.tool_name || permission.permission || '').toLowerCase();
  // GitHub 公开仓库只读放行（web_fetch github.com）
  if (tool === 'web_fetch') {
    const target =
      permission.description || String(permission.metadata?.url ?? permission.metadata?.filepath ?? '');
    return /github\.com/.test(target);
  }
  // 共享 UniBot 测试环境校验命令（bash 调用测试环境 venv python + 校验脚本，只读验证扩展）
  if (tool === 'bash') {
    const command = permission.description || String(permission.metadata?.command ?? '');
    const python = unibotEnvPython();
    const script = validationScriptPath();
    return command.includes(python) && command.includes(script);
  }
  if (tool !== 'read' && tool !== 'external_directory') return false;
  const allowlist = [...docsAllowlistPaths(), ...marketAllowlistPaths()];
  const candidates: string[] = [];
  if (typeof permission.metadata?.filepath === 'string') {
    candidates.push(permission.metadata.filepath);
  }
  if (typeof permission.metadata?.parentDir === 'string') {
    candidates.push(permission.metadata.parentDir);
  }
  for (const seg of permission.description.split(',')) {
    const t = seg.trim();
    if (t) candidates.push(t);
  }
  // pattern 形如 .../prompts/docs/*：`*` 视为任意子路径。
  // 只要任一白名单文档位于任一允许目录下即命中（方向是"文档 ∈ 允许目录"）。
  return allowlist.some((doc) =>
    candidates.some((raw) => {
      const p = normalizePath(raw);
      const dir = p.endsWith('/*') ? p.slice(0, -2) : p;
      return doc === dir || doc.startsWith(dir + '/');
    }),
  );
}

/**
 * 自动放行白名单文档读取（异步，由事件循环调用）：
 * 成功回复 OpenCode once 并返回 true（外层广播 auto_granted 供前端提示）；
 * 失败转人工确认（广播 permission.asked）并返回 false。
 * sessionId 必须取事件流中的真实会话（审核会话与主会话不同）。
 */
async function autoGrantDocsRead(
  draftId: string,
  sessionId: string,
  permission: PermissionRequest,
): Promise<boolean> {
  if (!sessionId || !permission.id) return false;
  try {
    await opencode.getClient().postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permission.id },
      body: { response: 'once' },
      query: { directory: draftWorkspace(draftId) },
    });
    logger.info('permission', '自动放行白名单文档读取', {
      draft_id: draftId,
      permission_id: permission.id,
      description: permission.description,
    });
    return true;
  } catch (e) {
    logger.warn('permission', '白名单文档读取自动放行失败，转人工确认', {
      draft_id: draftId,
      error: (e as Error).message,
    });
    broadcast({ type: 'permission.asked', draft_id: draftId, permission });
    return false;
  }
}

/**
 * 把 opencode 的 PermissionV1.Request（permission.asked 事件 properties / /permission 列表项）
 * 归一化为平台 PermissionRequest。
 * 注意：`permission` 字段就是工具名（bash / edit / read / external_directory…），
 * `tool` 是 { messageID, callID } 调用位置对象，不能当工具名用。
 */
export function toPermissionRequest(p: Record<string, unknown>): PermissionRequest {
  const patterns = Array.isArray(p.patterns) ? (p.patterns as unknown[]).map(String) : [];
  const metadata = (p.metadata as Record<string, unknown>) ?? {};
  const tool = p.tool as { messageID?: string; callID?: string } | undefined;
  const description =
    patterns.join(', ') ||
    String(metadata.filepath ?? metadata.parentDir ?? p.pattern ?? '');
  return {
    id: String(p.id ?? ''),
    session_id: String(p.sessionID ?? ''),
    permission: String(p.permission ?? p.type ?? ''),
    tool_name: String(p.permission ?? p.type ?? ''),
    description,
    metadata: {
      ...metadata,
      ...(tool?.messageID && tool.callID ? { tool } : {}),
    },
  };
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
      // 防御：个别版本可能直接下发字符串（如 "idle"）
      const statusRaw = props.status;
      const statusType =
        typeof statusRaw === 'string'
          ? statusRaw
          : String((statusRaw as Record<string, unknown> | undefined)?.type ?? '');
      return {
        ...base,
        type: 'session.status',
        status: statusType,
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
      // properties 直接就是 PermissionV1.Request：{ id, sessionID, permission, patterns[], metadata, always, tool }
      const permission = toPermissionRequest(props);
      // 白名单文档读取自动放行（不弹权限框）
      if (matchesDocsAllowlist(permission)) {
        return { ...base, type: 'permission.auto_granted', permission };
      }
      return { ...base, type: 'permission.asked', permission };
    }
    case 'permission.replied':
      // schema 字段为 requestID（不是 permissionID）
      return {
        ...base,
        type: 'permission.replied',
        permission_id: String(props.requestID ?? ''),
      };
    case 'question.asked': {
      // opencode 1.18 实际事件类型为 question.asked（SDK 1.18 未生成对应类型），
      // properties 直接就是 QuestionV1.Request：{ id, sessionID, questions[], tool? }。
      // 每条提问：{ header, question, options: [{label, description}], multiple?, custom? }
      const questions = Array.isArray(props.questions) ? (props.questions as unknown[]) : [];
      const question: QuestionRequest = {
        id: String(props.id ?? ''),
        session_id: sessionId,
        questions: questions
          .map((raw) => {
            const q = (raw ?? {}) as Record<string, unknown>;
            const options = Array.isArray(q.options)
              ? (q.options as unknown[]).map((o) => {
                  const opt = (o ?? {}) as Record<string, unknown>;
                  return {
                    label: String(opt.label ?? ''),
                    description: String(opt.description ?? ''),
                  };
                })
              : [];
            return {
              header: String(q.header ?? ''),
              question: String(q.question ?? ''),
              options,
              multiple: Boolean(q.multiple),
              custom: q.custom === undefined ? true : Boolean(q.custom),
            };
          })
          .filter((q) => q.question),
        tool: (() => {
          const t = props.tool as { messageID?: string; callID?: string } | undefined;
          return t?.messageID && t.callID ? { messageID: t.messageID, callID: t.callID } : undefined;
        })(),
      };
      if (!question.id || question.questions.length === 0) return null;
      return { ...base, type: 'question.asked', question };
    }
    // 兼容旧命名/防御：历史版本事件名可能是 question.updated
    case 'question.updated': {
      const q = (props.question ?? props) as Record<string, unknown>;
      const questions = Array.isArray(q.questions) ? (q.questions as unknown[]) : [];
      const question: QuestionRequest = {
        id: String(q.id ?? q.questionID ?? ''),
        session_id: sessionId,
        questions: questions.map((raw) => {
          const item = (raw ?? {}) as Record<string, unknown>;
          const options = Array.isArray(item.options)
            ? (item.options as unknown[]).map((o) => {
                const opt = (o ?? {}) as Record<string, unknown>;
                return { label: String(opt.label ?? ''), description: String(opt.description ?? '') };
              })
            : [];
          return {
            header: String(item.header ?? ''),
            question: String(item.question ?? item.prompt ?? ''),
            options,
            multiple: Boolean(item.multiple),
            custom: item.custom === undefined ? true : Boolean(item.custom),
          };
        }),
      };
      if (!question.id || question.questions.length === 0) return null;
      return { ...base, type: 'question.asked', question };
    }
    case 'question.replied':
      return {
        ...base,
        type: 'question.replied',
        question_id: String(props.requestID ?? ''),
      };
    case 'question.rejected':
      return {
        ...base,
        type: 'question.rejected',
        question_id: String(props.requestID ?? ''),
      };
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
/**
 * 修复（审查发现问题后）完成后：结算进展 → 有进展则重新审查。
 * 无进展熔断由 settleDebugging 处理（连续两轮 → failed）。
 */
async function settleAndRecheck(draftId: string) {
  try {
    const outcome = await settleDebugging(draftId);
    const afterSettle = readDraft(draftId);
    if (afterSettle.status === 'failed') {
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'failed' });
      return;
    }
    if (!outcome.changed) {
      // 修复无进展但未熔断：回到 draft 等待用户决定（前端展示原因）
      updateDraft(draftId, { status: 'draft', phase: null });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
      return;
    }
    // 有进展 → 重新审查
    await startReview(draftId);
    broadcast({ type: 'draft.updated', draft_id: draftId, status: 'reviewing' });
  } catch (e) {
    logger.error('events', '修复结算失败', { draft_id: draftId, error: (e as Error).message });
    const current = readDraft(draftId);
    if (current.status === 'debugging') {
      updateDraft(draftId, { status: 'draft', phase: null, error: (e as Error).message });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
    }
  }
}

/**
 * 闲置信号去重：opencode 在会话空闲时成对下发 session.status{type:'idle'} 与 session.idle
 * （见 opencode packages/opencode/src/session/status.ts 的 set()），SDK 的 onSseEvent
 * 不等待回调，两个事件会并发进入 settleSessionState，导致阶段流转执行两次
 * （编码提示词发双份、审查会话开两个）。按 draftId:sessionId 在短窗口内只处理一次。
 * busy 事件到达（新一轮运行开始）时清除标记。
 */
const LAST_IDLE = new Map<string, number>();
const IDLE_DEDUP_MS = 2000;

/**
 * 审查结算（导出供测试）：结算审核会话结果并推进草稿状态。
 * - SSE 路径与协调循环 reconcile 都走这里，短窗口内只结算一次（冷却去重）
 * - 结算失败（opencode 瞬时错误 / 会话异常 / 无输出）不再把草稿留在 reviewing：
 *   置回 draft 并附错误信息，用户可一键「重新审查」，避免永久卡在审查中
 */
const REVIEW_SETTLED_AT = new Map<string, number>();
const REVIEW_SETTLE_COOLDOWN_MS = 8000;
/** draftId -> 已成功结算的审核会话 id：must_fix 等待修复时会话仍 idle，
 *  reconcile 靠它区分「已结算等待处理」与「idle 事件丢失未结算」，避免循环重结算 */
const REVIEW_SETTLED_SESSION = new Map<string, string>();

export async function settleReviewAndAdvance(draftId: string): Promise<void> {
  const now = Date.now();
  const last = REVIEW_SETTLED_AT.get(draftId) ?? 0;
  if (now - last < REVIEW_SETTLE_COOLDOWN_MS) return;
  REVIEW_SETTLED_AT.set(draftId, now);
  try {
    const result = await settleReview(draftId);
    const after = readDraft(draftId);
    REVIEW_SETTLED_SESSION.set(draftId, after.review_session_id ?? '');
    logger.info('review', `审查完成`, {
      draft_id: draftId,
      extension_id: after.extension_id,
      status: result.status,
      issues: result.issues.length,
      must_fix: result.issues.filter((i) => i.severity === 'must_fix').length,
    });
    broadcast({ type: 'review.updated', draft_id: draftId, review: result });
    if (result.status === 'passed') {
      // 审查通过后自动执行机械校验（在共享 UniBot 测试环境中，见 validation.ts），
      // 校验通过才允许发布；失败则回到 draft 等待修复。
      try {
        const run = await runValidation(draftId);
        broadcast({ type: 'validation.updated', draft_id: draftId, run });
        if (run.status === 'passed') {
          updateDraft(draftId, { status: 'ready' });
        } else {
          const failedSteps = run.steps.filter((step) => step.status === 'failed');
          const envStep = failedSteps.find((step) => step.id === 'env');
          const failedNames = failedSteps.map((step) => step.name).join('、');
          updateDraft(draftId, {
            status: 'draft',
            error:
              envStep?.message ?? `机械校验未通过：${failedNames}（详见检查结果）`,
          });
        }
      } catch (validationError) {
        logger.error('validation', '审查后机械校验执行失败', {
          draft_id: draftId,
          error: (validationError as Error).message,
        });
        updateDraft(draftId, {
          status: 'draft',
          error: `机械校验失败：${(validationError as Error).message}`,
        });
      }
      broadcast({ type: 'draft.updated', draft_id: draftId, status: readDraft(draftId).status });
    } else {
      broadcast({ type: 'draft.updated', draft_id: draftId, status: after.status });
    }
  } catch (e) {
    logger.error('review', '审查结算失败，草稿回到 draft（可重试审查）', {
      draft_id: draftId,
      error: (e as Error).message,
    });
    let current;
    try {
      current = readDraft(draftId);
    } catch {
      return; // 草稿已删除
    }
    if (current.status === 'reviewing') {
      updateDraft(draftId, {
        status: 'draft',
        phase: null,
        error: `审查结算失败：${(e as Error).message}（可点击「重新审查」重试）`,
      });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
    }
  }
}

/**
 * 阶段状态调和（协调循环兜底）：
 * 草稿停留在阶段状态（planning / coding / debugging / reviewing）但对应 opencode
 * 会话实际已空闲时，按会话状态主动结算推进流水线，避免「一直显示运行中」。
 * 覆盖两类场景：
 * - SSE idle 事件丢失 / 订阅断开的间隙（原 reconcileReviewing）
 * - 后端重启后：opencode 会话已空闲不会重发 idle 事件，草稿会永久停在阶段状态，
 *   只能靠这里按 /session/status 兜底结算（planning→coding、coding→review、
 *   debugging→结算重查、reviewing→结算审查）。
 */
async function reconcileStuckDrafts(): Promise<void> {
  let drafts;
  try {
    drafts = listDrafts();
  } catch {
    return;
  }
  for (const draft of drafts) {
    if (!['planning', 'coding', 'debugging', 'reviewing'].includes(draft.status)) continue;
    const sessionId = draft.status === 'reviewing' ? draft.review_session_id : draft.session_id;
    if (!sessionId) continue;
    // 该审核会话已成功结算过（如 must_fix 等待用户点「自动修复」）→ 跳过，避免循环重结算
    if (draft.status === 'reviewing' && REVIEW_SETTLED_SESSION.get(draft.id) === sessionId) continue;
    try {
      const client = opencode.getClient();
      const res = await client.session.status({
        query: { directory: draftWorkspace(draft.id) },
      });
      const statuses = (res.data ?? {}) as Record<string, { type?: string }>;
      if (statuses[sessionId]?.type === 'idle') {
        logger.info('events', '调和：会话已空闲但草稿仍停留在阶段状态，主动结算', {
          draft_id: draft.id,
          status: draft.status,
          session_id: sessionId,
        });
        await settleSessionState(draft.id, sessionId, { type: 'session.idle' } as StudioEvent);
      }
    } catch (e) {
      logger.debug('events', '阶段状态调和失败（忽略）', {
        draft_id: draft.id,
        error: (e as Error).message,
      });
    }
  }
}

async function settleSessionState(draftId: string, sessionId: string, ev: StudioEvent) {
  if (ev.type === 'session.error') {
    // 主动中止（停止按钮 / abort 接口）会触发 opencode 的 MessageAbortedError，
    // 不是真正的会话错误：跳过，不置 error、不清除 phase
    //（abort 端点已先把 status 置为 draft，phase 留给「继续」时恢复）。
    if (ev.error.includes('MessageAbortedError') || ev.error.includes('Aborted')) {
      return;
    }
    let draft;
    try {
      draft = readDraft(draftId);
    } catch {
      return; // 草稿已删除
    }
    logger.warn('draft', `会话错误，草稿置为 error`, { draft_id: draftId, extension_id: draft.extension_id, error: ev.error });
    updateDraft(draftId, { status: 'error', phase: null, error: ev.error });
    broadcast({ type: 'draft.updated', draft_id: draftId, status: 'error' });
    return;
  }

  const isIdle = ev.type === 'session.idle' || (ev.type === 'session.status' && ev.status === 'idle');
  if (!isIdle) {
    // 新一轮运行开始（busy）→ 清除旧的闲置标记，避免后续真实完成被误判为重复事件
    if (ev.type === 'session.status' && ev.status === 'busy') {
      LAST_IDLE.delete(`${draftId}:${sessionId}`);
    }
    return;
  }
  // 成对事件去重（session.status{idle} 与 session.idle 只处理一次流转）
  const idleKey = `${draftId}:${sessionId}`;
  const now = Date.now();
  if (now - (LAST_IDLE.get(idleKey) ?? 0) < IDLE_DEDUP_MS) return;
  LAST_IDLE.set(idleKey, now);

  let draft;
  try {
    draft = readDraft(draftId);
  } catch {
    return; // 草稿已删除
  }

  // 主会话完成（规划 / 编码 / 修复）
  if (sessionId === draft.session_id) {
    // 规划完成 → 自动进入编码阶段
    if (draft.status === 'planning') {
      logger.info('draft', '规划完成，自动进入编码阶段', {
        draft_id: draftId,
        extension_id: draft.extension_id,
        session_id: sessionId,
      });
      try {
        await startCoding(draftId);
        broadcast({ type: 'draft.updated', draft_id: draftId, status: 'coding' });
      } catch (e) {
        logger.error('draft', '进入编码阶段失败', { draft_id: draftId, error: (e as Error).message });
        updateDraft(draftId, { status: 'draft', phase: null, error: (e as Error).message });
        broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
      }
      return;
    }
    // 编码完成 → 自动进入审查
    if (draft.status === 'coding') {
      logger.info('draft', '编码完成，自动进入审查阶段', {
        draft_id: draftId,
        extension_id: draft.extension_id,
        session_id: sessionId,
      });
      try {
        await startReview(draftId);
        broadcast({ type: 'draft.updated', draft_id: draftId, status: 'reviewing' });
      } catch (e) {
        logger.error('draft', '进入审查阶段失败', { draft_id: draftId, error: (e as Error).message });
        updateDraft(draftId, { status: 'draft', phase: null, error: (e as Error).message });
        broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
      }
      return;
    }
    if (draft.status === 'debugging') {
      logger.info('draft', '修复完成，进入结算', {
        draft_id: draftId,
        extension_id: draft.extension_id,
        session_id: sessionId,
      });
      await settleAndRecheck(draftId);
    }
    return;
  }

  // 审查会话完成 → 结算审查结果
  if (sessionId === draft.review_session_id) {
    await settleReviewAndAdvance(draftId);
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
          // 白名单文档读取：自动回复 OpenCode 放行；成功才广播 auto_granted，失败转人工
          if (ev.type === 'permission.auto_granted') {
            const granted = await autoGrantDocsRead(draftId, sessionId, ev.permission);
            if (!granted) return;
          }
          await settleSessionState(draftId, sessionId, ev);
          // normalize 产出的事件全部与草稿相关；unibot-env.updated 由 index.ts 直接广播，
          // 不会经过此处（联合类型含该无 draft_id 成员，此处显式收窄）
          broadcast({ ...ev, draft_id: draftId } as StudioEvent);
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
    // 兜底：阶段状态但会话已空闲的草稿（SSE 间隙 / 事件丢失 / 服务重启后）
    await reconcileStuckDrafts();
    await Bun.sleep(2000);
  }
}
