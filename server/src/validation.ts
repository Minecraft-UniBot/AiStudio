/**
 * 机械校验流水线：以受限子进程调用 UniBot 校验脚本（server/validation/validate_extension.py），
 * 在平台共享的 UniBot 测试环境（config.unibot_env.test_dir）中执行清单 schema、语法与
 * import 边界、Ruff、草稿自带测试、Loader 绑定与依赖声明检查。
 *
 * 结果结构化写入 draft.validation，通过时记录 validation_revision（发布前核对，
 * 对应 Plan.md 第四章「检查摘要过期后一键发布按钮立即锁定」）。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config, resSrcDir } from './config';
import { DraftError, computeRevision, draftWorkspace, readDraft, updateDraft } from './drafts';
import { logger } from './logger';
import { getUnibotEnvStatus, runProcess } from './unibot_env';
import type { ReviewIssue, ValidationRun, ValidationStepId, ValidationStepResult } from './types';

/** 同一草稿并发校验锁 */
const VALIDATION_LOCKS = new Set<string>();

/**
 * 把校验失败步骤转为可交给 AI 修复的问题单（提供「修复条件」）。
 * 环境类（id='env'）与中断类（id='interrupted'）步骤属于基础设施/运行问题，
 * AI 无法修复，予以排除；全部失败均为此类时返回空数组，调用方应引导重跑校验。
 */
export function validationFixIssues(run: ValidationRun): ReviewIssue[] {
  return (run.steps ?? [])
    .filter(
      (step) => step.status === 'failed' && step.id !== 'env' && step.id !== 'interrupted',
    )
    .map((step, i) => ({
      id: `vfix-${i + 1}`,
      severity: 'must_fix' as const,
      title: `机械校验失败：${step.name}`,
      detail: [step.message, step.detail].filter(Boolean).join('\n') || `校验步骤「${step.name}」未通过`,
    }));
}

/** 解析校验脚本输出的结构化 JSON */
function parseValidationOutput(
  stdout: string,
): { ok: boolean; steps: ValidationStepResult[]; error?: string } {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`校验脚本输出无法解析：${stdout.slice(-400)}`);
  const parsed = JSON.parse(jsonMatch[0]) as {
    ok?: boolean;
    error?: string;
    steps?: Array<{ id: string; name: string; ok: boolean; message?: string; detail?: string }>;
  };
  const steps: ValidationStepResult[] = (parsed.steps ?? []).map((step) => ({
    id: step.id as ValidationStepId,
    name: step.name,
    status: step.ok ? 'passed' : 'failed',
    message: step.message,
    detail: step.detail,
    duration_ms: 0,
  }));
  return { ok: parsed.ok ?? false, error: parsed.error, steps };
}

/** 执行机械校验并写入草稿（同步等待结果） */
export async function runValidation(draftId: string): Promise<ValidationRun> {
  if (VALIDATION_LOCKS.has(draftId)) {
    throw new DraftError('该草稿正在校验中，请稍候', 'VALIDATION_BUSY');
  }
  const draft = readDraft(draftId);
  const revision = computeRevision(draftId);
  const run: ValidationRun = {
    id: randomUUID(),
    status: 'running',
    steps: [],
    started_at: new Date().toISOString(),
    revision,
  };
  updateDraft(draftId, { validation: run, validation_revision: null });
  VALIDATION_LOCKS.add(draftId);
  try {
    // 环境必须已就绪（共享一份，见 unibot_env.ts）
    const env = getUnibotEnvStatus();
    if (env.state !== 'ready' || !env.venv_ready) {
      // 环境未就绪不是代码问题：记录为 failed 校验（env 步骤）而不是抛错，
      // 调用方据此提示「同步测试环境」，前端也能展示失败原因并给出对应操作
      const failed: ValidationRun = {
        ...run,
        status: 'failed',
        finished_at: new Date().toISOString(),
        steps: [
          {
            id: 'env',
            name: '测试环境',
            status: 'failed',
            message: 'UniBot 测试环境未就绪，请先在平台同步环境后再检查',
            detail: `当前环境状态：${env.state}${env.error ? '；' + env.error : ''}`,
            duration_ms: 0,
          },
        ],
      };
      updateDraft(draftId, { validation: failed });
      logger.warn('validation', '测试环境未就绪，机械校验未执行', {
        draft_id: draftId,
        env_state: env.state,
        env_error: env.error,
      });
      return failed;
    }
    const unibot_root = config.unibot_env.test_dir;
    const python = join(
      unibot_root,
      '.venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    const script = join(
      resSrcDir(),
      '..',
      'validation',
      'validate_extension.py',
    );
    const ext_dir = join(draftWorkspace(draftId), draft.extension_id);
    logger.info('validation', '开始机械校验', {
      draft_id: draftId,
      extension_id: draft.extension_id,
      unibot_root,
    });
    const result = await runProcess(
      python,
      [script, ext_dir, '--unibot-root', unibot_root],
      { cwd: draftWorkspace(draftId), timeout_ms: 10 * 60_000 },
    );
    let parsed: { ok: boolean; steps: ValidationStepResult[] };
    try {
      parsed = parseValidationOutput(result.output);
    } catch (error) {
      // 输出无 JSON：脚本本身异常退出
      const failed: ValidationRun = {
        ...run,
        status: 'failed',
        finished_at: new Date().toISOString(),
        steps: [
          {
            id: 'syntax',
            name: '校验执行',
            status: 'failed',
            message: (error as Error).message,
            detail: result.output.slice(-2000),
            duration_ms: 0,
          },
        ],
      };
      updateDraft(draftId, { validation: failed });
      logger.error('validation', '机械校验执行异常', {
        draft_id: draftId,
        error: (error as Error).message,
      });
      return failed;
    }
    const finished: ValidationRun = {
      ...run,
      status: parsed.ok ? 'passed' : 'failed',
      steps: parsed.steps,
      finished_at: new Date().toISOString(),
    };
    updateDraft(draftId, {
      validation: finished,
      ...(parsed.ok ? { validation_revision: revision } : {}),
    });
    logger.info('validation', '机械校验完成', {
      draft_id: draftId,
      extension_id: draft.extension_id,
      status: finished.status,
      steps: parsed.steps.length,
    });
    return finished;
  } finally {
    VALIDATION_LOCKS.delete(draftId);
  }
}
