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
import { opencode } from './gateway';
import { readDraft, updateDraft, draftWorkspace, listDrafts } from '../studio/drafts';
import { runValidation } from '../studio/validation';
import { startCoding } from '../ai/pipeline';
import { draftIdForSession, getDraftSessionIds, getWorkspaces } from '../studio/sessions';
import { logger } from '../core/logger';
import { docsAllowlistPaths, marketAllowlistPaths, unibotEnvPython, validationScriptPath } from '../core/config';
import type { PermissionRequest, QuestionRequest, StudioEvent } from '../core/types';

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
      // retry 携带重试细节（SDK SessionStatus.retry: { attempt, message, next }），
      // 原样透传给前端展示「模型请求失败，正在自动重试」，避免生成期间静默卡住
      const retryDetail =
        statusType === 'retry' && typeof statusRaw === 'object' && statusRaw
          ? {
              attempt: Number((statusRaw as Record<string, unknown>).attempt ?? 0),
              message: String((statusRaw as Record<string, unknown>).message ?? ''),
              next: Number((statusRaw as Record<string, unknown>).next ?? 0),
            }
          : undefined;
      return {
        ...base,
        type: 'session.status',
        status: statusType,
        ...(retryDetail ? { retry: retryDetail } : {}),
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
 * 闲置信号去重：opencode 在会话空闲时成对下发 session.status{type:'idle'} 与 session.idle
 * （见 opencode packages/opencode/src/session/status.ts 的 set()），SDK 的 onSseEvent
 * 不等待回调，两个事件会并发进入 settleSessionState，导致阶段流转执行两次
 * （编码提示词发双份）。按 draftId:sessionId 在短窗口内只处理一次。
 * busy 事件到达（新一轮运行开始）时清除标记。
 */
const LAST_IDLE = new Map<string, number>();
const IDLE_DEDUP_MS = 2000;

/**
 * 结算节流：协调循环每 2s 轮询一次，但一次 idle 结算往往伴随长耗时动作
 * （planning→coding 的 promptAsync、编码完成后的机械校验——机械校验执行期间
 * 草稿 status 仍停留在 coding），此时协调循环再次看到「阶段状态 + 会话 idle」
 * 就会重复触发结算：
 *   - coding→校验 的第二发会撞上 runValidation 的并发锁，
 *     catch 分支会把草稿误置为 draft + error（前端状态乱跳，表现为「无法正确判断
 *     正在进行」）；
 *   - planning→coding 的第二发会把编码提示词重复发送。
 * 真实 SSE idle 事件是一次性的（且已被 IDLE_DEDUP_MS 去重），协调循环只是兜底，
 * 因此对「刚结算过」的会话做 60s 节流即可；新一轮运行开始（busy）时清除标记。
 */
const LAST_SETTLED = new Map<string, number>();
const SETTLE_THROTTLE_MS = 60_000;

/**
 * 编码完成后自动执行机械校验（AGENT.md 3.5：不再有独立审核 AI，校验流水线把关）：
 * - 校验通过 → ready（可一键发布）
 * - 校验失败 → 回到 draft + 错误说明（前端提供「让 AI 修复校验问题」入口）
 * 校验失败不是死胡同：AI 读取失败步骤修复后，用户可点「重新校验」重跑。
 */
async function settleCodingAndValidate(draftId: string): Promise<void> {
  try {
    // 并发防御：机械校验已在执行时直接跳过（协调循环 2s 轮询可能在
    // 校验结束前再次触发结算，节流窗口外仍需此防线兜底）
    const current = readDraft(draftId);
    if (current.validation?.status === 'running') {
      logger.debug('events', '机械校验已在执行，跳过重复结算', { draft_id: draftId });
      return;
    }
    const run = await runValidation(draftId);
    broadcast({ type: 'validation.updated', draft_id: draftId, run });
    if (run.status === 'passed') {
      // 校验通过：清除生成期间记录的瞬时错误（如上游模型流式失败后自动恢复），
      // 避免横幅残留已不存在的错误误导用户
      updateDraft(draftId, { status: 'ready', error: undefined });
      logger.info('draft', '编码完成，机械校验通过，草稿进入 ready', {
        draft_id: draftId,
        extension_id: readDraft(draftId).extension_id,
      });
    } else {
      const failedSteps = run.steps.filter((step) => step.status === 'failed');
      const envStep = failedSteps.find((step) => step.id === 'env');
      const failedNames = failedSteps.map((step) => step.name).join('、');
      updateDraft(draftId, {
        status: 'draft',
        error: envStep?.message ?? `机械校验未通过：${failedNames}（详见检查结果）`,
      });
      logger.warn('draft', '编码完成，机械校验未通过，回到 draft', {
        draft_id: draftId,
        failed: failedNames,
      });
    }
    broadcast({ type: 'draft.updated', draft_id: draftId, status: readDraft(draftId).status });
  } catch (e) {
    logger.error('validation', '编码后机械校验执行失败', {
      draft_id: draftId,
      error: (e as Error).message,
    });
    updateDraft(draftId, {
      status: 'draft',
      error: `机械校验失败：${(e as Error).message}`,
    });
    broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
  }
}

/**
 * 阶段状态调和（协调循环兜底）：
 * 草稿停留在阶段状态（planning / coding）但对应 opencode 会话实际已空闲时，
 * 按会话状态主动结算推进流水线，避免「一直显示运行中」。
 * 覆盖两类场景：
 * - SSE idle 事件丢失 / 订阅断开的间隙
 * - 后端重启后：opencode 会话已空闲不会重发 idle 事件，草稿会永久停在阶段状态，
 *   只能靠这里按 /session/status 兜底结算（planning→coding、coding→机械校验）。
 */
async function reconcileStuckDrafts(): Promise<void> {
  let drafts;
  try {
    drafts = listDrafts();
  } catch {
    return;
  }
  for (const draft of drafts) {
    if (!['planning', 'coding'].includes(draft.status)) continue;
    const sessionId = draft.session_id;
    if (!sessionId) continue;
    try {
      const client = opencode.getClient();
      const res = await client.session.status({
        query: { directory: draftWorkspace(draft.id) },
      });
      const statuses = (res.data ?? {}) as Record<string, { type?: string }>;
      if (statuses[sessionId]?.type === 'idle') {
        // 结算节流：刚处理过 idle 结算的会话（如机械校验进行中）不再由协调循环
        // 重复结算，避免 2s 轮询在结算动作完成前反复触发（见 LAST_SETTLED 注释）
        const key = `${draft.id}:${sessionId}`;
        if (Date.now() - (LAST_SETTLED.get(key) ?? 0) < SETTLE_THROTTLE_MS) continue;
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
    // 规划/编码期间的会话错误（如上游模型流式失败、重试耗尽）：
    // 只记录错误文本供前端横幅展示，保留运行状态与 phase——opencode 随后必然下发
    // session.idle，若此处把 status 改成 error 会破坏 idle 结算判断（coding→机械校验、
    // planning→编码），草稿会永久卡在「异常」而无法自动流转。
    if (draft.status === 'planning' || draft.status === 'coding') {
      logger.warn('draft', `会话错误（保持运行状态，等待空闲结算）`, {
        draft_id: draftId,
        extension_id: draft.extension_id,
        status: draft.status,
        error: ev.error,
      });
      updateDraft(draftId, { error: ev.error });
      broadcast({ type: 'draft.updated', draft_id: draftId, status: draft.status });
      return;
    }
    logger.warn('draft', `会话错误，草稿置为 error`, { draft_id: draftId, extension_id: draft.extension_id, error: ev.error });
    updateDraft(draftId, { status: 'error', phase: null, error: ev.error });
    broadcast({ type: 'draft.updated', draft_id: draftId, status: 'error' });
    return;
  }

  const isIdle = ev.type === 'session.idle' || (ev.type === 'session.status' && ev.status === 'idle');
  if (!isIdle) {
    // 新一轮运行开始（busy）→ 清除旧的闲置/结算标记与上一轮的错误横幅，
    // 避免后续真实完成被误判为重复事件，或残留过期错误提示误导用户
    if (ev.type === 'session.status' && ev.status === 'busy') {
      const key = `${draftId}:${sessionId}`;
      LAST_IDLE.delete(key);
      LAST_SETTLED.delete(key);
      const current = (() => {
        try {
          return readDraft(draftId);
        } catch {
          return null;
        }
      })();
      if (current?.error) {
        updateDraft(draftId, { error: undefined });
        broadcast({ type: 'draft.updated', draft_id: draftId, status: current.status });
      }
    }
    return;
  }
  // 成对事件去重（session.status{idle} 与 session.idle 只处理一次流转）
  const idleKey = `${draftId}:${sessionId}`;
  const now = Date.now();
  if (now - (LAST_IDLE.get(idleKey) ?? 0) < IDLE_DEDUP_MS) return;
  LAST_IDLE.set(idleKey, now);
  // 记录结算时间：协调循环在 SETTLE_THROTTLE_MS 内不再对该会话重复结算
  //（结算动作如机械校验可能持续数秒到数十秒，期间 status 仍停留在阶段状态）
  LAST_SETTLED.set(idleKey, now);

  let draft;
  try {
    draft = readDraft(draftId);
  } catch {
    return; // 草稿已删除
  }

  // 主会话完成（规划 / 编码）
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
        // 成功进入编码：清除规划期间记录的瞬时错误
        updateDraft(draftId, { error: undefined });
        broadcast({ type: 'draft.updated', draft_id: draftId, status: 'coding' });
      } catch (e) {
        logger.error('draft', '进入编码阶段失败', { draft_id: draftId, error: (e as Error).message });
        updateDraft(draftId, { status: 'draft', phase: null, error: (e as Error).message });
        broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
      }
      return;
    }
    // 编码完成 → 自动机械校验（AI 已在编码阶段用测试工具自测；校验通过才 ready）
    if (draft.status === 'coding') {
      logger.info('draft', '编码完成，自动机械校验', {
        draft_id: draftId,
        extension_id: draft.extension_id,
        session_id: sessionId,
      });
      await settleCodingAndValidate(draftId);
      return;
    }
    return;
  }
}

// ===== 按工作区维护 SSE 订阅 =====

/** workspace 路径 -> AbortController（用于关闭订阅） */
const SUBSCRIPTIONS = new Map<string, AbortController>();

/** SSE 意外断开后的快速重订延迟（毫秒）：远小于协调循环的 2s 轮询，减少事件丢失窗口 */
const SSE_RESUBSCRIBE_DELAY_MS = 500;

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
        // 非主动关闭（草稿删除）时的意外断开：立即安排快速重订，
        // 不等协调循环下一轮（2s），缩小流式事件丢失窗口。
        // opencode 进程重启期间会失败，由协调循环兜底持续重试。
        if (!ac.signal.aborted) {
          setTimeout(() => {
            if (getWorkspaces().has(workspace)) void subscribeWorkspace(workspace);
          }, SSE_RESUBSCRIBE_DELAY_MS);
        }
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
    // 关闭已删除草稿的订阅，并清理其闲置去重/结算节流标记（防内存缓慢增长）
    for (const [workspace, ac] of SUBSCRIPTIONS) {
      if (!wanted.has(workspace)) {
        ac.abort();
        SUBSCRIPTIONS.delete(workspace);
        logger.info('events', '关闭 SSE 订阅', { workspace });
      }
    }
    // 清理已删除草稿的闲置去重/结算节流标记（key 形如 "<draftId>:<sessionId>"）：
    // 草稿删除后其会话登记被移除，按此判定 key 是否已失效，防止 Map 无限增长
    const live_draft_ids = new Set(getDraftSessionIds().keys());
    for (const key of [...LAST_IDLE.keys()]) {
      if (!live_draft_ids.has(key.split(':')[0] ?? '')) {
        LAST_IDLE.delete(key);
        LAST_SETTLED.delete(key);
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
