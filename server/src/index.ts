/**
 * Extension Studio 服务入口：REST / WebSocket 路由与平台认证。
 *
 * 对应 Plan.md 第六章「后端 API 草案」；错误统一使用 { code, data, message } 包装。
 * 安全：所有接口要求管理员权限（Bearer token），OpenCode 网关仅监听 127.0.0.1。
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ensureDataDirs, saveConfig, setUnibotDir, docsAllowlist, marketAllowlist, marketRegistryPath } from './config';
import { config } from './config';
import { issueToken, verifyToken } from './auth';
import { opencode, resolvePermissionTarget, normalizeProviders } from './opencode';
import { enableFileLogging, logger } from './logger';
import { trackSession, untrackDraft } from './sessions';
import {
  assertPromptable,
  computeRevision,
  createDraft,
  deleteDraft,
  DraftError,
  draftWorkspace,
  ensureGitWorkspace,
  inferResumeStatus,
  listDrafts,
  listFiles,
  readDraft,
  readDraftFile,
  resolveDraftPath,
  sanitizeTypes,
  updateDraft,
} from './drafts';
import { publishDraft, PublishError } from './publishing';
import { broadcast, registerSocket, startEventConsumer, unregisterSocket, toPermissionRequest } from './events';
import { getTools, updateTools } from './tools';
import { activatePrompt, getPrompt, listPrompts, renderPromptWithSecurity, savePrompt } from './prompts';
import { buildSecurity } from './pipeline';
import { ensureUnibotEnv, getUnibotEnvStatus, syncUnibotEnv } from './unibot_env';
import { runValidation, validationFixIssues } from './validation';
import {
  TestToolsError,
  deployToTestEnv,
  loadInTestEnv,
  readTestLog,
  runTestsInTestEnv,
  testEnvOverview,
  undeployFromTestEnv,
  validateDraft,
} from './test_tools';
import { assertFeatureEnabled } from './registry';
import { ensureTemplatesInit, getTemplate, listTemplates, pullTemplate } from './templates';
import { PreviewError, listTemplateNames, renderTemplatePreview } from './preview';
import type { DraftMeta } from './types';

// ===== 认证（HMAC 签名 token，密钥持久化，后端重启后仍有效；签发/校验见 auth.ts） =====

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
      unibot_configured: config.unibot_configured,
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

  // ---- 测试工具（OpenCode 插件回调，对应 AGENT.md 3.5） ----
  // 插件运行在 opencode 进程内，只转发 workspace + extension_id；所有文件/子进程操作
  // 由后端执行（test_tools.ts），路径校验与「只写测试环境」约束在 test_tools.ts 内。
  const testMatch = path.match(/^\/api\/studio\/test\/([a-z-]+)$/);
  if (testMatch && req.method === 'POST') {
    const action = testMatch[1]!;
    try {
      assertFeatureEnabled('test_tools');
      const body = (await req.json().catch(() => ({}))) as {
        workspace?: string;
        draft_id?: string;
        extension_id?: string;
        lines?: number;
      };
      const ref = { workspace: body.workspace ?? '', draft_id: body.draft_id ?? '' };
      const extensionId = body.extension_id ?? '';
      switch (action) {
        case 'env': {
          return json(testEnvOverview());
        }
        case 'sync': {
          void syncUnibotEnv().then((status) => broadcast({ type: 'unibot-env.updated', status }));
          return json(testEnvOverview());
        }
        case 'deploy': {
          const result = deployToTestEnv(ref, extensionId);
          return json(result);
        }
        case 'undeploy': {
          const result = undeployFromTestEnv(ref, extensionId);
          return json(result);
        }
        case 'load': {
          const result = await loadInTestEnv(ref, extensionId);
          return json(result);
        }
        case 'logs': {
          return json(readTestLog(extensionId, Math.min(Math.max(body.lines ?? 50, 1), 500)));
        }
        case 'run-tests': {
          const result = await runTestsInTestEnv(ref, extensionId);
          return json(result);
        }
        case 'validate': {
          const result = await validateDraft(ref, extensionId);
          return json(result);
        }
        default:
          return errorJson('未知测试工具动作', 404, 404);
      }
    } catch (e) {
      if (e instanceof TestToolsError) return errorJson(e.message, 1, 400);
      const status =
        (e as Error & { status?: number }).status ??
        (e as Error & { cause?: { status?: number } }).cause?.status;
      if (status) return errorJson((e as Error).message, 1, status);
      return errorJson((e as Error).message, 1, 400);
    }
  }

  if (path === '/api/studio/options' && req.method === 'GET') {
    try {
      const client = opencode.getClient();
      const [providersRes, agentsRes] = await Promise.all([
        client.config.providers({}),
        client.app.agents({}),
      ]);
      const providerList = (providersRes.data as { providers?: unknown[] })?.providers ?? [];
      // opencode Provider 结构：{ id, name, models: { [modelID]: Model } }，
      // models 是对象字典而非数组；Provider/Model 用 name。统一归一化给前端（见 opencode.ts）。
      const providers = normalizeProviders(providerList as Array<Record<string, unknown>>);
      const agents = (agentsRes.data as Array<{ name?: string }> ?? [])
        .map((a) => String(a.name ?? ''))
        .filter(Boolean);
      return json({ providers, agents, test_tools_enabled: config.features.test_tools });
    } catch (e) {
      return errorJson(`获取模型/Agent 失败：${(e as Error).message}`, 1, 503);
    }
  }

  // ---- 开发模板（开发模板扩展，见 AGENT.md「后续版本」/templates.ts） ----
  if (path === '/api/studio/templates' && req.method === 'GET') {
    return json(listTemplates());
  }

  const templatePullMatch = path.match(/^\/api\/studio\/templates\/([^/]+)\/pull$/);
  if (templatePullMatch && req.method === 'POST') {
    const templateId = templatePullMatch[1]!;
    try {
      return json(await pullTemplate(templateId));
    } catch (e) {
      return errorJson(`模板拉取失败：${(e as Error).message}`, 1, 400);
    }
  }

  const templateMatch = path.match(/^\/api\/studio\/templates\/([^/]+)$/);
  if (templateMatch && req.method === 'GET') {
    try {
      return json(getTemplate(templateMatch[1]!));
    } catch (e) {
      return errorJson((e as Error).message, 404, 404);
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
        template_id?: string | null;
      };
      if (!body.extension_id || !body.name || !body.description) {
        return errorJson('缺少必填字段（extension_id / name / description）');
      }
      // 校验所选模板存在且可实例化（minimal 恒可用；extension 模板必须已安装）
      const templateId = body.template_id && body.template_id !== 'minimal' ? body.template_id : null;
      if (templateId) {
        const info = getTemplate(templateId);
        if (info.kind === 'extension' && !info.installed) {
          return errorJson(`模板「${templateId}」尚未就绪，请稍后重试或先拉取该模板`, 1, 400);
        }
      }
      // 全局并发限制（Plan 8.2）：同一管理员同时最多一个规划/编码任务
      const active = listDrafts().filter((d) =>
        ['planning', 'coding'].includes(d.status),
      );
      if (active.length > 0) {
        return errorJson(
          `已有草稿「${active[0]!.name}」正在规划/编码中，请先等待其完成`,
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
        template_id: templateId,
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
            // 状态先行，再发送提示词：先把草稿置为运行阶段（前端立即显示「进行中」、
            // 切换停止按钮；会话空闲时也能正确触发下一阶段结算）。
            // phase 缺失（回退/旧草稿/会话错误恢复后）时按工作区是否已有 PLAN.md
            // 推断阶段，避免「AI 已在工作但界面仍显示空闲」的判断错误。
            const resumeStatus = inferResumeStatus(draft);
            updateDraft(draftId, {
              status: resumeStatus,
              phase: resumeStatus,
              // 新消息会触发 opencode 的 revert cleanup（物理删除被回退的消息），
              // 因此清除暂存过滤标记，避免把新消息也过滤掉。
              ...(draft.revert_message_id ? { revert_message_id: null } : {}),
            });
            broadcast({ type: 'draft.updated', draft_id: draftId, status: resumeStatus });
            try {
              await client.session.promptAsync({
                path: { id: sessionId },
                body: { parts: [{ type: 'text', text: body.text }] },
                query: { directory: workspace },
              });
            } catch (e) {
              // 发送失败：回滚运行态，避免草稿永久停留在「进行中」
              updateDraft(draftId, { status: 'draft', phase: null, error: (e as Error).message });
              broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
              throw e;
            }
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
            try {
              await client.session.abort({ path: { id: draft.session_id }, query: { directory: workspace } });
            } catch (e) {
              // abort 失败：AI 仍在运行，恢复阶段状态，避免界面误显示「已停止」
              const rollback =
                draft.phase === 'planning' || draft.phase === 'coding' ? draft.phase : 'draft';
              updateDraft(draftId, { status: rollback });
              broadcast({ type: 'draft.updated', draft_id: draftId, status: rollback });
              throw e;
            }
            logger.info('draft', '停止生成', { draft_id: draftId, extension_id: draft.extension_id });
            return json({ ok: true });
          }
          break;
        }
        case 'revert': {
          // 回退到某条用户消息之前：OpenCode 原生 revert（恢复文件状态 + 对话记录），
          // 之后旧校验结果一律失效，草稿回到 draft 状态等待重新生成。
          if (req.method === 'POST' && draft.session_id) {
            if (['planning', 'coding'].includes(draft.status)) {
              return errorJson('当前正在规划/编码中，请先停止或等待完成后再回退', 1, 409);
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
            // 文件已恢复、对话待物理清理：重置规划/校验摘要并记录回退点，锁定一键发布
            updateDraft(draftId, {
              status: 'draft',
              phase: null,
              validation: null,
              validation_revision: null,
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
        case 'preview': {
          // 模板预览：渲染包/模板扩展的 Jinja2 渲染预览（工作台右栏 iframe）
          if (req.method === 'POST') {
            const body = (await req.json().catch(() => ({}))) as { template?: string };
            try {
              return json(await renderTemplatePreview(draftId, body.template ?? ''));
            } catch (e) {
              if (e instanceof PreviewError) return errorJson(e.message, 1, 400);
              return errorJson(`模板预览失败：${(e as Error).message}`, 1, 400);
            }
          }
          if (req.method === 'GET') {
            try {
              return json({ templates: await listTemplateNames(draftId) });
            } catch (e) {
              if (e instanceof PreviewError) return errorJson(e.message, 1, 400);
              return errorJson(`模板列表读取失败：${(e as Error).message}`, 1, 400);
            }
          }
          break;
        }
        case 'check': {
          if (req.method === 'POST') {
            // 手动重新校验：通过 → ready；失败 → draft + 错误（与编码后自动校验一致）。
            // 这是校验失败/测试环境恢复后的重跑入口，避免草稿卡死在 draft。
            const run = await runValidation(draftId);
            broadcast({ type: 'validation.updated', draft_id: draftId, run });
            if (run.status === 'passed') {
              updateDraft(draftId, { status: 'ready' });
              broadcast({ type: 'draft.updated', draft_id: draftId, status: 'ready' });
            } else {
              const failedSteps = run.steps.filter((step) => step.status === 'failed');
              const envStep = failedSteps.find((step) => step.id === 'env');
              updateDraft(draftId, {
                status: 'draft',
                error:
                  envStep?.message ??
                  `机械校验未通过：${failedSteps.map((s) => s.name).join('、')}（详见检查结果）`,
              });
              broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
            }
            return json(run);
          }
          break;
        }
        case 'debug': {
          if (req.method === 'POST') {
            // 让 AI 修复机械校验失败项：把失败步骤作为问题单发送到编码会话，
            // AI 修复后由事件层自动重跑校验（对应 AGENT.md 3.5「AI 修复校验问题」）。
            const body = (await req.json().catch(() => ({}))) as {
              fix_validation?: boolean;
            };
            if (!body.fix_validation) {
              return errorJson('没有需要修复的问题', 1, 400);
            }
            const current = readDraft(draftId);
            if (current.validation?.status !== 'failed') {
              return errorJson('没有失败的机械校验记录，无需修复', 1, 400);
            }
            const issues = validationFixIssues(current.validation);
            if (issues.length === 0) {
              return errorJson(
                '校验失败来自测试环境（非代码问题，AI 无法修复），请先同步测试环境后再试',
                1,
                400,
              );
            }
            const client = opencode.getClient();
            const sessionId = current.session_id ?? (await ensureSession(current, client, workspace));
            const problemSheet = issues
              .map((issue, i) => `### 问题 ${i + 1}：${issue.title}\n${issue.detail}`)
              .join('\n\n');
            const prompt =
              `机械校验有 ${issues.length} 个失败项，请修复草稿中的对应问题。\n\n` +
              problemSheet +
              '\n\n修复完成后，用测试工具（unibot_deploy + unibot_run_tests）在测试环境验证，' +
              '并等待系统自动重新校验。';
            updateDraft(draftId, { status: 'coding', phase: 'coding' });
            broadcast({ type: 'draft.updated', draft_id: draftId, status: 'coding' });
            try {
              await client.session.promptAsync({
                path: { id: sessionId },
                body: { parts: [{ type: 'text', text: prompt }] },
                query: { directory: workspace },
              });
            } catch (e) {
              // 发送失败：回滚运行态，避免草稿永久停留在「编码中」且无可恢复路径
              updateDraft(draftId, { status: 'draft', phase: null, error: (e as Error).message });
              broadcast({ type: 'draft.updated', draft_id: draftId, status: 'draft' });
              throw e;
            }
            logger.info('draft', '让 AI 修复机械校验问题', {
              draft_id: draftId,
              extension_id: draft.extension_id,
              issues: issues.length,
            });
            return json({ ok: true, issues: issues.length });
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
        (p) => p.sessionID === draft.session_id,
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
      // 权限请求可能来自主会话（编码/修复）或测试工具触发的会话：必须回复到发起请求的会话，
      // 否则该会话会一直阻塞等待授权。从 opencode 待处理权限列表中按 id 定位发起会话
      //（列表为空/权限已消失时退回主会话）。
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
        unibot_dir: config.unibot_dir,
        unibot_configured: config.unibot_configured,
        extensions_dir: config.extensions_dir,
        data_dir: config.data_dir,
      });
    }
    if (req.method === 'PATCH') {
      const body = (await req.json()) as Record<string, unknown>;
      // 单独处理 UniBot 目录设置：需要校验目录是否为合法 UniBot 根
      if (typeof body.unibot_dir === 'string') {
        const result = setUnibotDir(body.unibot_dir);
        if (!result.ok) return errorJson(result.error, 1, 400);
        return json({
          features: config.features,
          defaults: config.defaults,
          unibot_dir: config.unibot_dir,
          unibot_configured: config.unibot_configured,
          extensions_dir: config.extensions_dir,
          data_dir: config.data_dir,
        });
      }
      // 其余字段（功能开关等）走通用合并保存
      const next = saveConfig(body as never);
      return json({
        features: next.features,
        defaults: next.defaults,
        unibot_dir: next.unibot_dir,
        unibot_configured: next.unibot_configured,
        extensions_dir: next.extensions_dir,
        data_dir: next.data_dir,
      });
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
 * 静态资源服务（单文件可执行版 / 静态托管模式，对应 config.static_dir）：
 * - 前端构建产物由 Studio Server 同源提供，REST 与 WebSocket 走同一端口
 * - 单文件可执行版由 release/src/main.ts 解压内置 web/dist 后通过
 *   UNIBOT_STUDIO_STATIC_DIR 注入；开发模式不设 static_dir 时不提供静态服务
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
      logger.debug('ws', 'WebSocket 连接升级', { path: url.pathname });
      return undefined;
    }
    const start = Date.now();
    // 静态资源优先于 API 路由（登录页等前端资源无需认证）
    let res: Response | null = null;
    let isStatic = false;
    if (config.static_dir) {
      res = serveStatic(req, url);
      if (res) isStatic = true;
    }
    if (!res) res = await handleRequest(req);
    const ms = Date.now() - start;
    // 访问日志分级：静态资源归 debug（避免每次页面加载刷屏），API 按状态码分级
    // （4xx/5xx 高亮为 warn，错误一目了然），耗时与查询串作为结构化字段
    if (isStatic) {
      logger.debug('http', `${req.method} ${url.pathname}`, { status: res.status, ms });
    } else if (res.status >= 400) {
      logger.warn('http', `${req.method} ${url.pathname}`, {
        status: res.status,
        ms,
        query: url.search || undefined,
      });
    } else {
      logger.info('http', `${req.method} ${url.pathname}`, {
        status: res.status,
        ms,
        query: url.search || undefined,
      });
    }
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
// 日志同时落盘 <数据目录>/logs/studio.log（开发模式与单文件版一致；
// 单文件版启动器自己的消息在 import 本模块前已写入同一文件，见 release/src/main.ts）
const logFilePath = enableFileLogging();
await opencode.start();

// 初始化开发模板（后台拉取 Default 模板，不阻塞启动；见 templates.ts ensureTemplatesInit）
ensureTemplatesInit();

// 后台拉取 UniBot 测试环境（不阻塞启动：可能耗时数分钟；状态通过
// /api/studio/unibot-env 查询，完成后广播 unibot-env.updated）
void ensureUnibotEnv();

// 恢复已存在草稿的会话登记（必须在事件订阅启动之前，
// 否则订阅协调循环看不到这些工作区）
for (const draft of listDrafts()) {
  // 旧版草稿没有 phase 字段：按当前 status 回填（保证中止后继续的自动流转对旧草稿同样生效）
  if (
    !draft.phase &&
    (draft.status === 'planning' || draft.status === 'coding')
  ) {
    updateDraft(draft.id, { phase: draft.status });
  }
  // 服务重启前正在执行的机械校验（进程被杀）落盘为 failed：
  // 否则校验记录永久停留在「进行中」，重启后仍显示运行中
  if (draft.validation?.status === 'running') {
    updateDraft(draft.id, {
      validation: {
        ...draft.validation,
        status: 'failed',
        finished_at: new Date().toISOString(),
        steps: [
          {
            id: 'interrupted',
            name: '机械校验',
            status: 'failed',
            message: '机械校验因服务重启中断，未完成',
            detail: '请点「重新校验」重新执行机械校验。',
            duration_ms: 0,
          },
        ],
      },
      error: undefined,
    });
    logger.warn('draft', '启动恢复：中断的机械校验记录已置为失败', {
      draft_id: draft.id,
      extension_id: draft.extension_id,
    });
  }
  if (draft.session_id) {
    trackSession(draft.id, draft.session_id);
    logger.debug('sessions', '启动时恢复会话登记', {
      draft_id: draft.id,
      session_id: draft.session_id,
    });
  }
}

// 启动横幅放在 startEventConsumer 之前：它是无限循环（永不 resolve），
// 放在 await 之后会导致「启动完成 / 访问口令」永远不打印。
const oc = opencode.getStatus();
logger.info('server', 'Extension Studio 启动完成', {
  url: `http://${config.host}:${config.port}`,
  data_dir: config.data_dir,
  log_file: logFilePath ?? 'off',
  unibot_dir: config.unibot_dir,
  opencode: oc.available ? `可用 v${oc.version}` : `不可用（${oc.error ?? '-'}）`,
});
// 单文件可执行版"零配置"体验的关键一行：口令只在本机打印，
// 方便双击运行的用户直接从终端复制登录（配置同时落盘 <data>/config/studio.json）
logger.info('auth', `访问口令：${config.auth.password}（保存在 ${join(config.data_dir, 'config', 'studio.json')}）`);

// 事件消费是无限循环（永不 resolve）：不能 await（会卡死模块顶层，
// 使下方信号处理注册与单文件启动器的 import 返回都失效），后台运行即可。
void startEventConsumer();

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
