/**
 * 模板预览服务：把草稿工作区的渲染包/模板扩展用 Jinja2 渲染成完整 HTML，供前端 iframe 预览。
 *
 * 复用 UniBot venv 的 Python（内含 jinja2）子进程调用 server/validation/preview_template.py，
 * 与校验流水线（validation.ts / test_tools.ts）走同一套受限子进程约束（固定 cwd、超时、输出上限）。
 *
 * 安全：只读取草稿工作区内的 Templates 目录，输出为用户可见的 HTML，不写任何文件。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, previewScriptPath, unibotEnvPython } from '../core/config';
import { draftWorkspace, readDraft } from './drafts';
import { runProcess } from './unibot_env';
import { logger } from '../core/logger';

/** 预览相关错误 */
export class PreviewError extends Error {
  constructor(
    message: string,
    public code: string = 'PREVIEW_ERROR',
  ) {
    super(message);
  }
}

/** 挑选可用的 Python：优先 UniBot venv（必含 jinja2），否则退回系统 python3 */
function pickPython(): string {
  const venvPython = unibotEnvPython();
  if (existsSync(venvPython)) return venvPython;
  return 'python3';
}

/** 草稿的模板根目录（<workspace>/<extension_id>/Templates） */
export function draftTemplatesDir(draftId: string): string {
  const draft = readDraft(draftId);
  return join(draftWorkspace(draftId), draft.extension_id, 'Templates');
}

/** 列出草稿可预览的模板名（如 ['Server','List',...]） */
export async function listTemplateNames(draftId: string): Promise<string[]> {
  const templatesDir = draftTemplatesDir(draftId);
  if (!existsSync(templatesDir)) {
    throw new PreviewError('该草稿没有 Templates 目录，暂无可预览的模板', 'NO_TEMPLATES');
  }
  const python = pickPython();
  const script = previewScriptPath();
  const result = await runProcess(
    python,
    [script, '--templates-dir', templatesDir, '--list'],
    { timeout_ms: 60_000 },
  );
  if (result.code !== 0) {
    throw new PreviewError(`模板列表读取失败：${result.output.slice(-300)}`, 'LIST_FAILED');
  }
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 渲染指定模板为完整 HTML 文档（Jinja2 + 内置占位数据）。
 * @param draftId 草稿 id
 * @param templateName 模板名（如 Server）；省略时渲染第一个可用模板
 * @param opts 可选覆盖：width/height 渲染尺寸
 */
export async function renderTemplatePreview(
  draftId: string,
  templateName?: string,
  opts: { width?: number; height?: number } = {},
): Promise<{ html: string; template: string; templates: string[] }> {
  const templates = await listTemplateNames(draftId);
  const template = templateName && templates.includes(templateName) ? templateName : templates[0]!;
  const templatesDir = draftTemplatesDir(draftId);
  const python = pickPython();
  const script = previewScriptPath();
  const context = JSON.stringify({
    width: opts.width ?? 720,
    height: opts.height ?? 760,
  });
  const result = await runProcess(
    python,
    [script, '--templates-dir', templatesDir, '--template', template, '--context', context],
    { timeout_ms: 120_000 },
  );
  if (result.code !== 0) {
    logger.warn('preview', '模板渲染失败', {
      draft_id: draftId,
      template,
      error: result.output.slice(-400),
    });
    throw new PreviewError(`模板渲染失败：${result.output.trim().slice(-200)}`, 'RENDER_FAILED');
  }
  return { html: result.output, template, templates };
}