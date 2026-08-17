/**
 * 审查流程测试：
 * - 审核输出解析（parseReviewOutput）
 * - 权限请求回复路由（resolvePermissionTarget：审核/调试会话必须回到发起会话）
 * - startReview 占位审核结果（清空旧 must_fix，避免审查中误触自动修复）
 * - settleReview 无输出抛错、settleReviewAndAdvance 失败不滞留 reviewing
 *
 * 用临时数据目录：直接改写 config 单例（bun test 全量运行会共享模块缓存，
 * 依赖 env 在导入前设置不可靠）；mock opencode 网关的 getClient，避免拉起真实进程。
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft, updateDraft, readDraft } from '../src/drafts';
import { parseReviewOutput, startReview, settleReview } from '../src/review';
import { resolvePermissionTarget, normalizeProviders, opencode } from '../src/opencode';
import { settleReviewAndAdvance } from '../src/events';
import { config } from '../src/config';

const dataDir = mkdtempSync(join(tmpdir(), 'studio-review-test-'));
const originalDataDir = config.data_dir;
const originalExtensionsDir = config.extensions_dir;
const originalTestDir = config.unibot_env.test_dir;

beforeAll(() => {
  config.data_dir = dataDir;
  config.extensions_dir = join(dataDir, 'extensions');
  config.unibot_env.test_dir = join(dataDir, 'unibot');
});

afterAll(() => {
  config.data_dir = originalDataDir;
  config.extensions_dir = originalExtensionsDir;
  config.unibot_env.test_dir = originalTestDir;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
});

let draft_index = 0

function makeDraft() {
  draft_index += 1
  return createDraft({
    extension_id: `ReviewTest${draft_index}`,
    name: '审查测试',
    description: '测试审查流程。',
    types: ['command'],
    model: null,
    agent: 'build',
  });
}

/** 给草稿安装审核会话并置为审查中 */
function startReviewState(draftId: string, sessionId = 'ses_review_test') {
  updateDraft(draftId, { status: 'reviewing', phase: 'reviewing', review_session_id: sessionId });
  return sessionId;
}

/** mock opencode.getClient：消息列表返回审核助手文本 */
function mockMessages(assistantText: string) {
  opencode.getClient = (() => ({
    session: {
      messages: async () => ({
        data: assistantText
          ? [
              {
                info: { role: 'assistant', id: 'm1' },
                parts: [{ type: 'text', text: assistantText }],
              },
            ]
          : [],
      }),
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
    session_create: async () => {},
  })) as never;
}

describe('parseReviewOutput', () => {
  test('解析纯 JSON 输出', () => {
    const text = JSON.stringify({
      summary: '总体良好',
      issues: [
        { severity: 'must_fix', title: 'A', detail: '细节', file: 'a.py' },
        { severity: 'suggestion', title: 'B' },
      ],
    });
    const { summary, issues } = parseReviewOutput(text);
    expect(summary).toBe('总体良好');
    expect(issues).toHaveLength(2);
    expect(issues[0]!.severity).toBe('must_fix');
    expect(issues[0]!.file).toBe('a.py');
    expect(issues[1]!.severity).toBe('suggestion');
  });

  test('解析 markdown 代码块包裹的 JSON（AI 常见输出）', () => {
    const text = '审查完成，结果如下：\n```json\n{"summary":"ok","issues":[]}\n```';
    const { summary, issues } = parseReviewOutput(text);
    expect(summary).toBe('ok');
    expect(issues).toHaveLength(0);
  });

  test('无法解析时兜底为 must_fix（而非抛错）', () => {
    const { summary, issues } = parseReviewOutput('审核通过，无问题。');
    expect(issues[0]!.severity).toBe('must_fix');
    expect(issues[0]!.title).toBe('审核结果无法解析');
    expect(summary).toContain('无法解析');
  });

  test('非法 severity 归一化为 suggestion', () => {
    const text = JSON.stringify({
      summary: 's',
      issues: [{ severity: 'critical', title: 'X' }],
    });
    expect(parseReviewOutput(text).issues[0]!.severity).toBe('suggestion');
  });
});

describe('resolvePermissionTarget', () => {
  const pending = [
    { id: 'perm-main', sessionID: 'ses_main', permission: 'edit', patterns: ['a.py'] },
    { id: 'perm-review', sessionID: 'ses_review', permission: 'bash', patterns: ['uv run ...'] },
  ];

  test('权限属于审核会话时回复到审核会话', () => {
    const { sessionId, tool } = resolvePermissionTarget(pending, 'perm-review', 'ses_main');
    expect(sessionId).toBe('ses_review');
    expect(tool).toBe('bash');
  });

  test('权限属于主会话时回复到主会话', () => {
    const { sessionId, tool } = resolvePermissionTarget(pending, 'perm-main', 'ses_main');
    expect(sessionId).toBe('ses_main');
    expect(tool).toBe('edit');
  });

  test('权限已消失时退回主会话', () => {
    const { sessionId, tool } = resolvePermissionTarget(pending, 'perm-gone', 'ses_main');
    expect(sessionId).toBe('ses_main');
    expect(tool).toBe('');
  });
});

describe('normalizeProviders（模型列表归一化）', () => {
  test('models 为对象字典时正确展开（真实 opencode 结构）', () => {
    // 与 opencode 1.18.4 /config/providers 真实返回一致的结构
    const providers = normalizeProviders([
      {
        id: 'opencode',
        name: 'OpenCode Zen',
        source: 'custom',
        env: ['OPENCODE_API_KEY'],
        models: {
          'hy3-free': {
            id: 'hy3-free',
            name: 'Hy3 Free',
            api: { id: 'hy3-free', url: 'https://opencode.ai/zen/v1', npm: '@ai-sdk/openai-compatible' },
            capabilities: {},
          },
          'deepseek-v4-flash-free': {
            id: 'deepseek-v4-flash-free',
            name: 'DeepSeek V4 Flash Free',
            capabilities: {},
          },
        },
      },
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.label).toBe('OpenCode Zen');
    expect(providers[0]!.models).toEqual([
      { id: 'hy3-free', label: 'Hy3 Free' },
      { id: 'deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
    ]);
  });

  test('model 无 name 时退回字典 key 作为 label', () => {
    const providers = normalizeProviders([
      { id: 'p1', name: 'P1', models: { 'gpt-x': { id: 'gpt-x' } } },
    ]);
    expect(providers[0]!.models[0]).toEqual({ id: 'gpt-x', label: 'gpt-x' });
  });

  test('空 provider 列表返回空数组', () => {
    expect(normalizeProviders([])).toEqual([]);
  });
});

describe('startReview 占位审核结果', () => {
  test('写入审查中占位：清空旧 must_fix、保留轮次、设置 review_session_id', async () => {
    const draft = makeDraft();
    startReviewState(draft.id, 'ses_review_old');
    // 上一轮存在 must_fix
    updateDraft(draft.id, {
      review: {
        round: 1,
        max_rounds: 3,
        status: 'needs_confirmation',
        issues: [{ id: 'issue-1', severity: 'must_fix', title: '旧问题', detail: '' }],
        summary: '旧结果',
        rounds: [{ round: 1, revision_before: 'abc', must_fix_count: 1 }],
        updated_at: new Date().toISOString(),
      },
    });
    // mock 会话创建与提示词发送
    opencode.getClient = (() => ({
      session: {
        create: async () => ({ data: { id: 'ses_review_new' } }),
        promptAsync: async () => ({}),
      },
    })) as never;

    await startReview(draft.id);
    const after = readDraft(draft.id);
    expect(after.status).toBe('reviewing');
    expect(after.phase).toBe('reviewing');
    expect(after.review_session_id).toBe('ses_review_new');
    // 审查中占位：无 must_fix（前端按钮显示「审查中…」而非「自动修复」）
    expect(after.review?.status).toBe('needs_confirmation');
    expect(after.review?.issues).toHaveLength(0);
    // 轮次历史保留（无进展熔断依据）
    expect(after.review?.rounds).toHaveLength(1);
    expect(after.review?.round).toBe(1);
  });
});

describe('settleReview / settleReviewAndAdvance', () => {
  test('审核会话无输出时抛错，而不是伪造 must_fix', async () => {
    const draft = makeDraft();
    startReviewState(draft.id);
    mockMessages('');
    await expect(settleReview(draft.id)).rejects.toThrow(/没有输出内容/);
  });

  test('结算失败后草稿离开 reviewing（可重试，不卡死）', async () => {
    const draft = makeDraft();
    startReviewState(draft.id);
    mockMessages('');
    await settleReviewAndAdvance(draft.id);
    const after = readDraft(draft.id);
    expect(after.status).toBe('draft');
    expect(after.phase).toBeNull();
    expect(after.error).toContain('审查结算失败');
  });

  test('审核通过后即使机械校验不可用也不滞留 reviewing', async () => {
    const draft = makeDraft();
    startReviewState(draft.id);
    mockMessages(JSON.stringify({ summary: '通过', issues: [] }));
    await settleReviewAndAdvance(draft.id);
    const after = readDraft(draft.id);
    // 测试环境没有 UniBot 测试环境 → 机械校验抛 ENV_NOT_READY → 回到 draft 而非卡在 reviewing
    expect(after.status).not.toBe('reviewing');
  });
});
