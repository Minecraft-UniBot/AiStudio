/**
 * Extension Studio 服务入口：REST / WebSocket 路由与平台认证。
 *
 * 对应 Plan.md 第六章「后端 API 草案」；错误统一使用 { code, data, message } 包装。
 * 安全：所有接口要求管理员权限（Bearer token），OpenCode 网关仅监听 127.0.0.1。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ensureDataDirs, saveConfig, docsAllowlist, marketAllowlist, marketRegistryPath } from './config';
import { config } from './config';
import { opencode, resolvePermissionTarget } from './opencode';
import { logger } from './logger';
import { trackSession, untrackDraft } from './sessions';
import {
  assertPromptable,
  computeRevision,
  createDraft,
  deleteDraft,
  DraftError,
  draftWorkspace,
  ensureGitWorkspace,
  listDrafts,
  listFiles,
  readDraft,
  readDraftFile,
  resolveDraftPath,
  sanitizeTypes,
  updateDraft,
} from './drafts';
import { startReview } from './review';
import { startDebugging } from './debugging';
import { publishDraft, PublishError } from './publishing';
import { broadcast, registerSocket, startEventConsumer, unregisterSocket, toPermissionRequest } from './events';
import { getTools, updateTools } from './tools';
import { activatePrompt, getPrompt, listPrompts, renderPromptWithSecurity, savePrompt } from './prompts';
import { buildSecurity } from './pipeline';
import { ensureUnibotEnv, getUnibotEnvStatus, syncUnibotEnv } from './unibot_env';
import { runValidation } from './validation';
import { assertFeatureEnabled } from './registry';
import type { DraftMeta } from './types';

// ===== 认证（HMAC 签名 token，密钥持久化，后端重启后仍有效） =====
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function signTokenPayload(payload: string): string {
  return createHmac('sha256', config.auth.token_secret).update(payload).digest('base64url');
}

function issueToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS }),
  ).toString('base64url');
  return `${payload}.${signTokenPayload(payload)}`;
}

function verifyToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts as [string, string];
  const expected = Buffer.from(signTokenPayload(payload));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as {
      exp?: number;
    };
    return typeof data.exp === 'number' && data.exp >= Date.now();
  } catch {
    return false;
  }
}

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return verifyToken(auth.slice(7));
  // 允许通过 cookie 或 x-studio-token 头
  const header = req.headers.get('x-studio-token');
  return header ? verifyToken(header) : false;
}

function json(data: unknown, code = 0, message = ''): Response {
  return Response.json({ code, data, message });
}

function errorJson(message: string, code = 1, status = 400): Response {
  return Response.json({ code, data: null, message }, { status });
}

// ===== 工具注册表（tools.ts 持久化实现，见 Plan.md 7.2） =====

/** 统一安全约束与编码阶段编排（见 pipeline.ts） */

function draftFileList(draftId: string) {
  const draft = readDraft(draftId);
  // 文件树以扩展目录为根（去掉 workspace/<ExtensionId>/ 前缀）
  const prefix = `${draft.extension_id}/`;
  const files = listFiles(draftId)
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length));
  return files.map((f) => {
    const full = resolveDraftPath(draftId, `${prefix}${f}`);
    return { path: f, size: statSync(full).size };
  });
}

// ===== 路由 =====
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // 登录
  if (path === '/api/studio/auth/login' && req.method === 'POST') {
    try {
      const body = (await req.json()) as { password?: string };
      if (body.password === config.auth.password) {
        logger.info('auth', '管理员登录成功');
        return json({ token: issueToken() });
      }
      logger.warn('auth', '登录口令错误');
      return errorJson('口令错误', 401, 401);
    } catch {
      return errorJson('请求格式错误');
    }
  }

  // 除登录外全部要求认证
  if (!isAuthorized(req)) {
    logger.warn('auth', '未授权访问', { path, method: req.method });
    return errorJson('未授权', 401, 401);
  }

  // ---- 平台状态 ----
  if (path === '/api/studio/status' && req.method === 'GET') {
    return json({
      ...opencode.getStatus(),
      unibot_dir: config.unibot_dir,
      extensions_dir: config.extensions_dir,
      unibot_env: getUnibotEnvStatus(),
    });
  }

  // ---- UniBot 测试环境（自动拉取最新源码 + uv 依赖，供校验流水线使用） ----
  if (path === '/api/studio/unibot-env' && req.method === 'GET') {
    return json(getUnibotEnvStatus());
  }

  if (path === '/api/studio/unibot-env/sync' && req.method === 'POST') {
    // 后台执行同步（可能耗时数分钟），完成后通过 unibot-env.updated 事件推送；立即返回当前状态
    void syncUnibotEnv().then((status) => broadcast({ type: 'unibot-env.updated', status }));
    return json(getUnibotEnvStatus());
  }

  if (path === '/api/studio/options' && req.method === 'GET') {
    try {
      const client = opencode.getClient();
      const [providersRes, agentsRes] = await Promise.all([
        client.config.providers({}),
        client.app.agents({}),
      ]);
      const providerList = (providersRes.data as { providers?: unknown[] })?.providers ?? [];
      const providers = (providerList as Array<Record<string, unknown>>)
        .map((p) => ({
          provider_id: String(p.id ?? ''),
          label: String(p.label ?? p.id ?? ''),
          models: Array.isArray(p.models)
            ? p.models.map((m) => ({
                id: String((m as Record<string, unknown>).id ?? m),
                label: String((m as Record<string, unknown>).label ?? (m as Record<string, unknown>).id ?? m),
              }))
            : [],
        }))
        .filter((p) => p.provider_id);
      const agents = (agentsRes.data as Array<{ name?: string }> ?? [])
        .map((a) => String(a.name ?? ''))
        .filter(Boolean);
      return json({ providers, agents, review_enabled: config.features.review });
    } catch (e) {
      return errorJson(`获取模型/Agent 失败：${(e as Error).message}`, 1, 503);
    }
  }

  // ---- 草稿 ----
  if (path === '/api/studio/drafts' && req.method === 'GET') {
    return json(listDrafts());
  }

  if (path === '/api/studio/drafts' && req.method === 'POST') {
    try {
      const body = (await req.json()) as {
        extension_id?: string;
        name?: string;
        description?: string;
        types?: string[];
        model?: { provider_id?: string; model_id?: string } | null;
        agent?: string;
      };
      if (!body.extension_id || !body.name || !body.description) {
        return errorJson('缺少必填字段（extension_id / name / description）');
      }
      // 全局并发限制（Plan 8.2）：同一管理员同时最多一个规划/编码/修复任务
      const active = listDrafts().filter((d) =>
        ['planning', 'coding', 'debugging'].includes(d.status),
      );
      if (active.length > 0) {
        return errorJson(
          `已有草稿「${active[0]!.name}」正在规划/编码/修复中，请先等待其完成`,
          1,
          409,
        );
      }
      const types = sanitizeTypes(body.types ?? []);
      const draft = createDraft({
        extension_id: body.extension_id,
        name: body.name,
        description: body.description,
        types,
        model: body.model?.provider_id && body.model?.model_id
          ? { provider_id: body.model.provider_id, model_id: body.model.model_id }
          : null,
        agent: body.agent ?? config.defaults.agent,
      });

      // 创建 OpenCode session 并进入「规划」阶段
      const client = opencode.getClient();
      const workspace = draftWorkspace(draft.id);
      // 旧版草稿可能没有 git 仓库：补齐后再建会话（回退功能依赖，见 ensureGitWorkspace）
      ensureGitWorkspace(draft.id);
      const created = await client.session.create({
        body: { title: draft.name },
        query: { directory: workspace },
      });
      const sessionId = created.data?.id;
      if (!sessionId) {
        deleteDraft(draft.id);
        return errorJson('创建 OpenCode 会话失败');
      }
      trackSession(draft.id, sessionId);
      updateDraft(draft.id, { session_id: sessionId, status: 'planning' });
      logger.info('draft', '创建草稿并进入规划阶段', {
        draft_id: draft.id,
        extension_id: draft.extension_id,
        session_id: sessionId,
        types: draft.types,
        model: draft.model?.model_id ?? 'auto',
      });

      // 提示词模板化（Plan 7.1）：planning + system 均从 prompts/*.md 渲染，
      // 安全约束由后端追加（路径白名单、文档/市场白名单、联网规则），不进入可编辑模板
      const security = buildSecurity(workspace);
      const system = renderPromptWithSecurity('system', {
        allowlist: workspace,
        market_path: marketRegistryPath(),
      }, security);
      const planningPrompt = renderPromptWithSecurity('planning', {
        name: draft.name,
        extension_id: draft.extension_id,
        types: draft.types.join('、'),
        user_request: draft.description,
        allowlist: workspace,
        market_path: marketRegistryPath(),
        docs_path: docsAllowlist(),
      }, security);

      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: planningPrompt }],
          agent: draft.agent,
          system,
        },
        query: { directory: workspace },
      });
      return json({ draft: readDraft(draft.id), session_id: sessionId });
    } catch (e) {
      if (e instanceof DraftError) return errorJson(e.message, 1, 400);
      return errorJson(`创建草稿失败：${(e as Error).message}`, 1, 500);
    }
  }

  // ---- 单个草稿 ----
  const draftMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)$/);
  if (draftMatch) {
    const draftId = draftMatch[1]!;
    try {
      const draft = readDraft(draftId);
      if (req.method === 'GET') {
        return json(draft);
      }
      if (req.method === 'DELETE') {
        deleteDraft(draftId);
        untrackDraft(draftId);
        logger.info('draft', '删除草稿', { draft_id: draftId, extension_id: draft.extension_id });
        return json({ ok: true });
      }
    } catch (e) {
      if (e instanceof DraftError) return errorJson(e.message, 404, 404);
    }
  }

  // ---- 草稿子资源 ----
  const subMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)\/([a-z]+)$/);
  if (subMatch) {
    const draftId = subMatch[1]!;
    const resource = subMatch[2]!;
    try {
      const draft = readDraft(draftId);
      const client = opencode.getClient();
      const workspace = draftWorkspace(draftId);

      switch (resource) {
        case 'messages': {
          if (req.method === 'GET') {
            if (!draft.session_id) return json([]);
            const res = await client.session.messages({
              path: { id: draft.session_id },
              query: { directory: workspace },
            });
            let list = res.data ?? [];
            // OpenCode revert 是暂存式：文件已恢复，但被回退的消息要等下一次 prompt
            // 才物理删除。按草稿记录的 revert_message_id 过滤，让前端立即看到回退结果
            //（消息 ID 为 ULID，字典序即时间序，与 opencode cleanup 的判定一致：>= 目标即删除）。
            if (draft.revert_message_id) {
              list = list.filter((m) => !m.info || m.info.id < draft.revert_message_id!);
            }
            return json(list);
          }
          if (req.method === 'POST') {
            assertPromptable(draft);
            const body = (await req.json()) as { text?: string };
            if (!body.text?.trim()) return errorJson('消息不能为空');
            const sessionId = draft.session_id ?? (await ensureSession(draft, client, workspace));
            await client.session.promptAsync({
              path: { id: sessionId },
              body: { parts: [{ type: 'text', text: body.text }] },
              query: { directory: workspace },
            });
            // 新消息会触发 opencode 的 revert cleanup（物理删除被回退的消息），
            // 因此清除暂存过滤标记，避免把新消息也过滤掉。
            // 状态恢复：abort 后用户重新发消息视为「继续当前阶段」，按 phase 恢复 status，
            // 否则流水线在会话再次空闲时不会自动进入下一阶段（planning→coding 等）。
            const resumeStatus =
              draft.phase === 'planning' || draft.phase === 'coding' || draft.phase === 'debugging'
                ? draft.phase
                : 'draft';
            updateDraft(draftId, {
              status: resumeStatus,
              ...(draft.revert_message_id ? { revert_message_id: null } : {}),
            });
            logger.info('draft', '发送新消息', {
              draft_id: draftId,
              extension_id: draft.extension_id,
              text: body.text.slice(0, 120),
            });
            return json({ ok: true });
          }
          break;
        }
        case 'abort': {
          if (req.method === 'POST' && draft.session_id) {
            // 先置回 draft：session.abort 会触发 opencode 的 MessageAbortedError 与 idle 事件，
            // 必须让事件回调看到非阶段状态，避免「中止」被误判为「阶段完成」而自动进入下一阶段；
            // phase 保留，用户重新发消息时恢复（见 messages 端点）。
            updateDraft(draftId, { status: 'draft' });
            await client.session.abort({ path: { id: draft.session_id }, query: { directory: workspace } });
            logger.info('draft', '停止生成', { draft_id: draftId, extension_id: draft.extension_id });
            return json({ ok: true });
          }
          break;
        }
        case 'revert': {
          // 回退到某条用户消息之前：OpenCode 原生 revert（恢复文件状态 + 对话记录），
          // 之后旧校验/审核结果一律失效，草稿回到 draft 状态等待重新生成。
          if (req.method === 'POST' && draft.session_id) {
            if (['planning', 'coding', 'debugging', 'reviewing'].includes(draft.status)) {
              return errorJson('当前正在规划/编码/审查中，请先停止或等待完成后再回退', 1, 409);
            }
            const body = (await req.json()) as { message_id?: string };
            if (!body.message_id) return errorJson('缺少 message_id');
            // 旧版草稿可能没有 git 仓库：补齐后再回退（OpenCode 快照恢复文件依赖 git，
            // 否则 revert 只暂存对话而不恢复文件——即此前 revert 失效的原因）。
            ensureGitWorkspace(draftId);
            const res = await client.session.revert({
              path: { id: draft.session_id },
              body: { messageID: body.message_id },
              query: { directory: workspace },
            });
            // 校验 revert 真正生效：opencode 找不到目标消息时返回未变更的 Session（无 revert 字段），
            // 不能当成成功处理（SDK throwOnError 只覆盖 4xx/5xx，不覆盖这种静默 no-op）。
            const staged = res.data?.revert;
            if (!staged || staged.messageID !== body.message_id) {
              return errorJson('回退未生效：目标消息不存在或会话状态异常，请刷新后重试', 1, 400);
            }
            // 文件已恢复、对话待物理清理：重置规划/审查/摘要并记录回退点，锁定一键发布
            updateDraft(draftId, {
              status: 'draft',
              phase: null,
              validation: null,
              validation_revision: null,
              review: null,
              review_revision: null,
              plan_summary: null,
              revert_message_id: body.message_id,
              error: undefined,
            });
            broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
            logger.info('draft', '回退消息', {
              draft_id: draftId,
              extension_id: draft.extension_id,
              message_id: body.message_id,
              revert_staged: staged.messageID,
            });
            return json({ ok: true });
          }
          break;
        }
        case 'files': {
          if (req.method === 'GET') return json(draftFileList(draftId));
          break;
        }
        case 'diff': {
          if (req.method === 'GET' && draft.session_id) {
            const res = await client.session.diff({ path: { id: draft.session_id }, query: { directory: workspace } });
            return json(res.data ?? null);
          }
          return json(null);
        }
        case 'todo': {
          if (req.method === 'GET' && draft.session_id) {
            const res = await client.session.todo({ path: { id: draft.session_id }, query: { directory: workspace } });
            return json(res.data ?? []);
          }
          return json([]);
        }
        case 'check': {
          if (req.method === 'POST') {
            // 机械校验（在共享 UniBot 测试环境中执行，见 validation.ts）
            const run = await runValidation(draftId);
            broadcast({ type: 'validation.updated', draft_id: draftId, run });
            return json(run);
          }
          break;
        }
        case 'validate': {
          if (req.method === 'POST') {
            // 三阶段流程不再有独立校验：此端点改为触发「审查」（兼容旧前端调用）
            const review = await startReview(draftId);
            return json(review);
          }
          break;
        }
        case 'review': {
          if (req.method === 'POST') {
            assertFeatureEnabled('review');
            const review = await startReview(draftId);
            return json(review);
          }
          if (req.method === 'GET') {
            return json(draft.review ?? null);
          }
          break;
        }
        case 'debug': {
          if (req.method === 'POST') {
            // 审查后的自动修复：
            // - 有 must_fix → 自动修复（审查未通过）
            // - 无 must_fix 但用户请求（include_suggestions）→ 附带 suggestion 一起修
            const body = (await req.json().catch(() => ({}))) as { include_suggestions?: boolean };
            const current = readDraft(draftId);
            const reviewMustFix = current.review?.issues?.filter((i) => i.severity === 'must_fix');
            const reviewSuggestions = current.review?.issues?.filter(
              (i) => i.severity === 'suggestion',
            );
            if (reviewMustFix?.length) {
              const review = await startDebugging(draftId);
              return json(review);
            }
            if (body.include_suggestions && reviewSuggestions?.length) {
              const review = await startDebugging(draftId, null, { include_suggestions: true });
              return json(review);
            }
            return errorJson('没有需要修复的问题', 1, 400);
          }
          break;
        }
        case 'publish': {
          if (req.method === 'POST') {
            try {
              const record = publishDraft(draftId);
              broadcast({ type: 'draft.published', draft_id: draftId });
              return json(record);
            } catch (e) {
              if (e instanceof PublishError) return errorJson(e.message, 1, 400);
              throw e;
            }
          }
          break;
        }
      }
    } catch (e) {
      if (e instanceof DraftError) return errorJson(e.message, 404, 404);
      // SDK throwOnError 抛出的 Error 把原始状态码放在 cause.status（见 opencode.ts 文件头）
      const status =
        (e as Error & { status?: number }).status ??
        (e as Error & { cause?: { status?: number } }).cause?.status;
      if (status) return errorJson((e as Error).message, 1, status);
      return errorJson((e as Error).message, 1, 400);
    }
  }

  // ---- 文件内容 ----
  const fileMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)\/files\/content$/);
  if (fileMatch && req.method === 'GET') {
    const draftId = fileMatch[1]!;
    try {
      const draft = readDraft(draftId);
      const rel = url.searchParams.get('path') ?? '';
      // 文件树以扩展目录为根，解析时拼上扩展 ID 前缀（对应 workspace/<ExtensionId>/）
      const content = readDraftFile(draftId, `${draft.extension_id}/${rel}`);
      return json({ content });
    } catch (e) {
      if (e instanceof DraftError) return errorJson(e.message);
      return errorJson(`读取文件失败：${(e as Error).message}`, 1, 500);
    }
  }

  // ---- 待处理权限列表（SSE 事件丢失/断线重连后的兜底补推） ----
  const permListMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)\/permissions$/);
  if (permListMatch && req.method === 'GET') {
    const draftId = permListMatch[1]!;
    const draft = readDraft(draftId);
    try {
      const pending = await opencode.listPendingPermissions(draftWorkspace(draftId));
      const mine = pending.filter(
        (p) => p.sessionID === draft.session_id || p.sessionID === draft.review_session_id,
      );
      return json(mine.map((p) => toPermissionRequest(p)));
    } catch (e) {
      return errorJson(`获取待处理权限失败：${(e as Error).message}`, 1, 503);
    }
  }

  // ---- 权限回复 ----
  const permMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)\/permissions\/([^/]+)$/);
  if (permMatch && req.method === 'POST') {
    const [, draftId, permissionId] = permMatch;
    const draft = readDraft(draftId!);
    const body = (await req.json()) as { response?: 'once' | 'always' | 'reject' };
    const response = body.response;
    if (!response || !['once', 'always', 'reject'].includes(response)) {
      return errorJson('response 必须是 once / always / reject');
    }
    try {
      // 权限请求可能来自主会话、审核会话或调试会话：必须回复到发起请求的会话，
      // 否则审核/调试会话会一直阻塞等待授权，草稿永远停在 reviewing。
      // 从 opencode 待处理权限列表中按 id 定位发起会话（列表为空/权限已消失时退回主会话）。
      const pending = await opencode.listPendingPermissions(draftWorkspace(draftId!));
      const { sessionId, tool } = resolvePermissionTarget(pending, permissionId!, draft.session_id!);
      const decision = response === 'always' && tool === 'bash' ? 'once' : response;
      await opencode
        .getClient()
        .postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId! },
          body: { response: decision as 'once' | 'always' | 'reject' },
          query: { directory: draftWorkspace(draftId!) },
        });
      logger.info('permission', '回复权限请求', {
        draft_id: draftId,
        permission_id: permissionId,
        session_id: sessionId,
        tool,
        response: decision,
      });
      broadcast({ type: 'permission.replied', draft_id: draftId!, permission_id: permissionId! });
      return json({ ok: true });
    } catch (e) {
      return errorJson(`权限回复失败：${(e as Error).message}`, 1, 400);
    }
  }

  // ---- 问题回复（question 工具回答走 OpenCode 原生 reply 端点，不是普通文本消息） ----
  const qRejectMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)\/questions\/([^/]+)\/reject$/);
  if (qRejectMatch && req.method === 'POST') {
    const [, draftId, questionId] = qRejectMatch;
    readDraft(draftId!);
    try {
      await opencode.questionReject(questionId!, draftWorkspace(draftId!));
      return json({ ok: true });
    } catch (e) {
      return errorJson(`忽略问题失败：${(e as Error).message}`, 1, 400);
    }
  }

  const qMatch = path.match(/^\/api\/studio\/drafts\/([^/]+)\/questions\/([^/]+)$/);
  if (qMatch && req.method === 'POST') {
    const [, draftId, questionId] = qMatch;
    const draft = readDraft(draftId!);
    const body = (await req.json()) as { answers?: string[][] };
    if (!Array.isArray(body.answers) || body.answers.length === 0) {
      return errorJson('answers 不能为空（每个问题一个数组，元素为选项 label）');
    }
    try {
      await opencode.questionReply(questionId!, body.answers, draftWorkspace(draftId!));
      logger.info('draft', '回答 AI 提问', {
        draft_id: draftId,
        extension_id: draft.extension_id,
        question_id: questionId,
        answers: body.answers.map((a) => (a ?? []).join(' / ')),
      });
      return json({ ok: true });
    } catch (e) {
      return errorJson(`回答失败：${(e as Error).message}`, 1, 400);
    }
  }

  // ---- 平台设置 ----
  if (path === '/api/studio/settings') {
    if (req.method === 'GET') {
      return json({
        features: config.features,
        defaults: config.defaults,
        opencode: { version: config.opencode.version, data_dir: config.opencode.data_dir },
      });
    }
    if (req.method === 'PATCH') {
      const body = (await req.json()) as Record<string, unknown>;
      const next = saveConfig(body as never);
      return json({ features: next.features, defaults: next.defaults });
    }
  }

  // ---- 工具注册表（持久化到 config/tools.json，Plan 7.2） ----
  if (path === '/api/studio/tools') {
    if (req.method === 'GET') return json(getTools());
    if (req.method === 'PATCH') {
      const body = (await req.json()) as unknown[];
      return json(updateTools(body as never));
    }
  }

  // ---- 提示词模板（版本化，Plan 7.1） ----
  if (path === '/api/studio/prompts' && req.method === 'GET') {
    return json(listPrompts());
  }
  const activateMatch = path.match(/^\/api\/studio\/prompts\/([^/]+)\/activate$/);
  if (activateMatch && req.method === 'POST') {
    const name = activateMatch[1]!;
    const body = (await req.json()) as { version?: number };
    if (!body.version) return errorJson('version 不能为空');
    const activated = activatePrompt(name, body.version);
    if (!activated) return errorJson('模板或版本不存在', 404, 404);
    return json({ name, ...activated });
  }
  const promptMatch = path.match(/^\/api\/studio\/prompts\/([^/]+)$/);
  if (promptMatch && req.method === 'GET') {
    const name = promptMatch[1]!;
    const versionParam = url.searchParams.get('version');
    const version = versionParam ? Number(versionParam) : undefined;
    const prompt = getPrompt(name, version);
    if (!prompt) return errorJson('模板不存在', 404, 404);
    return json({ name, ...prompt });
  }
  if (promptMatch && req.method === 'POST') {
    const name = promptMatch[1]!;
    const body = (await req.json()) as { content?: string };
    if (!body.content) return errorJson('content 不能为空');
    const created = savePrompt(name, body.content);
    return json({ name, ...created });
  }

  return errorJson('接口不存在', 404, 404);
}

async function ensureSession(
  draft: DraftMeta,
  client: ReturnType<typeof opencode.getClient>,
  workspace: string,
): Promise<string> {
  // 旧版草稿可能没有 git 仓库：补齐后再建会话（回退功能依赖，见 ensureGitWorkspace）
  ensureGitWorkspace(draft.id);
  const created = await client.session.create({
    body: { title: draft.name },
    query: { directory: workspace },
  });
  const sessionId = created.data?.id;
  if (!sessionId) throw new Error('创建会话失败');
  trackSession(draft.id, sessionId);
  updateDraft(draft.id, { session_id: sessionId });
  return sessionId;
}

// ===== 启动 =====
/**
 * 静态资源服务（桌面客户端模式，对应 config.static_dir）：
 * - 前端构建产物由 Studio Server 同源提供，REST 与 WebSocket 走同一端口
 * - SPA 回退：非 /api 且文件不存在的 GET 一律回退 index.html（支持 /workspace/:id 等前端路由）
 * - 路径穿越防护：规范化后必须仍位于 static_dir 之内
 */
function serveStatic(req: Request, url: URL): Response | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const dir = config.static_dir;
  if (!dir) return null;
  if (url.pathname.startsWith('/api/')) return null;

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const filePath = resolve(join(dir, rel));
  if (!filePath.startsWith(resolve(dir) + sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  let target = filePath;
  try {
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
  } catch {
    // 文件不存在：走 SPA 回退
  }
  if (!existsSync(target)) {
    target = join(dir, 'index.html');
    if (!existsSync(target)) return null;
  }
  return new Response(Bun.file(target));
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: async (req, server) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/studio/events') {
      // WebSocket 无法携带自定义 header，token 通过 query 传递
      const queryToken = url.searchParams.get('token') ?? '';
      const headerToken = req.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      if (!isAuthorized(req) && !verifyToken(queryToken) && !verifyToken(headerToken)) {
        logger.warn('ws', 'WebSocket 未授权连接被拒绝');
        return Response.json({ code: 401, data: null, message: '未授权' }, { status: 401 });
      }
      const upgraded = server.upgrade(req);
      if (!upgraded) return Response.json({ code: 500, data: null, message: '升级失败' }, { status: 500 });
      return undefined;
    }
    const start = Date.now();
    // 静态资源优先于 API 路由（登录页等前端资源无需认证）
    if (config.static_dir) {
      const staticRes = serveStatic(req, url);
      if (staticRes) return staticRes;
    }
    const res = await handleRequest(req);
    logger.info('http', `${req.method} ${url.pathname} -> ${res.status}`, {
      ms: Date.now() - start,
      query: url.search || undefined,
    });
    return res;
  },
  websocket: {
    open(ws) {
      registerSocket(ws);
      logger.debug('ws', 'WebSocket 客户端已连接');
    },
    close(ws) {
      unregisterSocket(ws);
      logger.debug('ws', 'WebSocket 客户端断开');
    },
    message(ws, message) {
      // 心跳 / 客户端消息（第一版无上行协议）
      if (message === 'ping') ws.send('pong');
    },
  },
});

ensureDataDirs();
await opencode.start();

// 后台拉取 UniBot 测试环境（不阻塞启动：可能耗时数分钟；状态通过
// /api/studio/unibot-env 查询，完成后广播 unibot-env.updated）
void ensureUnibotEnv();

// 恢复已存在草稿的会话登记（必须在事件订阅启动之前，
// 否则订阅协调循环看不到这些工作区）
for (const draft of listDrafts()) {
  // 旧版草稿没有 phase 字段：按当前 status 回填（保证中止后继续的自动流转对旧草稿同样生效）
  if (
    !draft.phase &&
    (draft.status === 'planning' || draft.status === 'coding' || draft.status === 'debugging')
  ) {
    updateDraft(draft.id, { phase: draft.status });
  }
  if (draft.session_id) {
    trackSession(draft.id, draft.session_id);
    logger.debug('sessions', '启动时恢复会话登记', {
      draft_id: draft.id,
      session_id: draft.session_id,
    });
  }
  if (draft.review_session_id) {
    trackSession(draft.id, draft.review_session_id);
  }
}

await startEventConsumer();

const oc = opencode.getStatus();
logger.info('server', 'Extension Studio 启动完成', {
  url: `http://${config.host}:${config.port}`,
  data_dir: config.data_dir,
  unibot_dir: config.unibot_dir,
  opencode: oc.available ? `可用 v${oc.version}` : `不可用（${oc.error ?? '-'}）`,
});

// 优雅退出
process.on('SIGINT', async () => {
  logger.info('server', '收到 SIGINT，正在退出');
  await opencode.stop();
  server.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('server', '收到 SIGTERM，正在退出');
  await opencode.stop();
  server.stop();
  process.exit(0);
});
