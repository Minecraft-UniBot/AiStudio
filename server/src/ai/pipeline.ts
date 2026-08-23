/**
 * 阶段编排：规划（planning）→ 编码（coding）的两阶段流水线。
 * 编码完成后由事件层自动触发机械校验（不再有独立审查）。
 * 独立模块避免 index.ts <-> events.ts 循环依赖。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftWorkspace, readDraft, updateDraft, DraftError, promptModelChoice } from '../studio/drafts';
import { opencode } from '../opencode/gateway';
import { logger } from '../core/logger';
import {
  config,
  docsAllowlist,
  marketAllowlist,
  marketRegistryPath,
  unibotEnvPython,
  validationScriptPath,
} from '../core/config';
import { renderPromptWithSecurity } from './prompts';
import { renderSkillsSection } from './skills';
import { renderMcServerContext } from '../studio/mc_server';

/** 统一安全约束：路径边界、文档/市场白名单、网络规则、扩展 ID 一致 */
export function buildSecurity(workspace: string, mcServerDir?: string | null): string {
  const items = [
    `只能操作草稿工作区：${workspace}（目录之外的一切内容禁止读取或修改）。`,
    `本地文档只读白名单（仅可读取，禁止修改）：\n${docsAllowlist()}`,
    `扩展市场注册表只读白名单（仅可读取，用于复用已有扩展）：\n${marketAllowlist()}`,
  ];
  if (mcServerDir) {
    items.push(
      `目标 MC 服务器目录只读白名单（仅可读取其配置/插件清单，禁止修改或删除；` +
        `禁止读取 server.properties 等含密钥的敏感内容）：${mcServerDir}`,
    );
  }
  items.push(
    '禁止读取 .env、凭据、密钥类文件及 UniBot 核心代码、配置、用户数据。',
    '允许 web_fetch 只读访问 GitHub 公开仓库（github.com），用于参考已有扩展实现；' +
      '其余联网（web_search / 第三方文档等）需先说明目的并等待用户确认。',
    '涉及 shell 命令时，先说明目的并等待用户确认。',
    '扩展目录名与 Extension.toml 的 extension.id 必须完全一致（含大小写）。',
    `共享 UniBot 测试环境（只读，用于运行校验脚本验证扩展，禁止修改其内容）：\n` +
      `   - 环境根目录：${config.unibot_env.test_dir}\n` +
      `   - 校验命令：${unibotEnvPython()} ${validationScriptPath()} <扩展目录> --unibot-root ${config.unibot_env.test_dir}\n` +
      '   - 扩展目录为草稿工作区内的扩展目录（如 <workspace>/<ExtensionId>）；运行前先确认测试环境已就绪。',
    `测试工具（unibot_*，OpenCode 插件注册）：可把草稿扩展部署到测试环境并加载/运行测试验证，\n` +
      `   只允许操作测试环境（${config.unibot_env.test_dir}），禁止触碰正式扩展目录；部署前先调 unibot_test_status 确认环境就绪。`,
  );
  return items.map((text, i) => `${i + 1}. ${text}`).join('\n');
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
  const security = buildSecurity(workspace, draft.mc_server?.dir);
  const system = renderPromptWithSecurity(
    'system',
    { allowlist: workspace, market_path: marketRegistryPath() },
    security + renderSkillsSection(draft.types),
  );
  const codingPrompt = renderPromptWithSecurity('scaffold', {
    extension_id: draft.extension_id,
    allowlist: workspace,
    market_path: marketRegistryPath(),
    server_context: renderMcServerContext(draft.mc_server ?? null),
  }, security);
  // 状态先行：进入编码运行态后再发送提示词，前端立即显示「编码中」；
  // promptAsync 失败时由调用方（events.settleSessionState）回滚为 draft
  updateDraft(draftId, { status: 'coding', phase: 'coding' });
  await client.session.promptAsync({
    path: { id: draft.session_id },
    body: {
      parts: [{ type: 'text', text: codingPrompt }],
      agent: draft.agent,
      system,
      model: promptModelChoice(draft),
    },
    query: { directory: workspace },
  });
  logger.info('draft', '规划完成，进入编码阶段', {
    draft_id: draftId,
    extension_id: draft.extension_id,
    session_id: draft.session_id,
  });
}
