/**
 * 阶段编排：规划（planning）→ 编码（coding）→ 审查（reviewing）的三阶段流水线。
 * 独立模块避免 index.ts <-> events.ts 循环依赖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftWorkspace, readDraft, updateDraft, DraftError } from './drafts';
import { opencode } from './opencode';
import { logger } from './logger';
import { docsAllowlist, marketAllowlist, marketRegistryPath } from './config';
import { renderPromptWithSecurity } from './prompts';
import { renderSkillsSection } from './skills';

/** 统一安全约束：路径边界、文档/市场白名单、网络规则、扩展 ID 一致 */
export function buildSecurity(workspace: string): string {
  return [
    `1. 只能操作草稿工作区：${workspace}（目录之外的一切内容禁止读取或修改）。`,
    `2. 本地文档只读白名单（仅可读取，禁止修改）：\n${docsAllowlist()}`,
    `3. 扩展市场注册表只读白名单（仅可读取，用于复用已有扩展）：\n${marketAllowlist()}`,
    '4. 禁止读取 .env、凭据、密钥类文件及 UniBot 核心代码、配置、用户数据。',
    '5. 允许 web_fetch 只读访问 GitHub 公开仓库（github.com），用于参考已有扩展实现；' +
      '其余联网（web_search / 第三方文档等）需先说明目的并等待用户确认。',
    '6. 涉及 shell 命令时，先说明目的并等待用户确认。',
    '7. 扩展目录名与 Extension.toml 的 extension.id 必须完全一致（含大小写）。',
  ].join('\n');
}

/** 提取规划文件摘要（PLAN.md 前 800 字，供审查上下文与前端展示） */
function extractPlanSummary(draftId: string): string | null {
  try {
    const planFile = join(draftWorkspace(draftId), 'PLAN.md');
    if (!existsSync(planFile)) return null;
    const content = readFileSync(planFile, 'utf-8').trim();
    if (!content) return null;
    return content.slice(0, 800);
  } catch {
    return null;
  }
}

/** 编码阶段提示词：读取 PLAN.md + 市场参考 + 自动加载 skill 实现 */
export async function startCoding(draftId: string): Promise<void> {
  const draft = readDraft(draftId);
  const client = opencode.getClient();
  const workspace = draftWorkspace(draftId);
  if (!draft.session_id) throw new DraftError('草稿没有会话，无法开始编码', 'NO_SESSION');
  // 规划产物摘要存入草稿元数据（审查上下文用）
  const planSummary = extractPlanSummary(draftId);
  if (planSummary) {
    updateDraft(draftId, { plan_summary: planSummary });
  }
  const security = buildSecurity(workspace);
  const system = renderPromptWithSecurity(
    'system',
    { allowlist: workspace, market_path: marketRegistryPath() },
    security + renderSkillsSection(draft.types),
  );
  const codingPrompt = renderPromptWithSecurity('scaffold', {
    extension_id: draft.extension_id,
    allowlist: workspace,
    market_path: marketRegistryPath(),
  }, security);
  await client.session.promptAsync({
    path: { id: draft.session_id },
    body: {
      parts: [{ type: 'text', text: codingPrompt }],
      agent: draft.agent,
      system,
    },
    query: { directory: workspace },
  });
  updateDraft(draftId, { status: 'coding', phase: 'coding' });
  logger.info('draft', '规划完成，进入编码阶段', {
    draft_id: draftId,
    extension_id: draft.extension_id,
    session_id: draft.session_id,
  });
}
