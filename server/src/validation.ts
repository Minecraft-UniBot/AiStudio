/**
 * 校验流水线编排：以受限子进程调用 UniBot 校验脚本（Studio 目录内的
 * validate_extension.py），结果映射为结构化步骤，发布前核对文件摘要。
 *
 * 安全约束（对应 Plan.md 8.2）：
 * - 子进程固定 cwd 为 UniBot 根目录（只读复用工具链，不修改 UniBot 任何文件）
 * - 不继承机器人 Token 等敏感环境变量
 * - 命令白名单（仅固定的 python -m 调用）、超时、输出大小上限
 * - 并发限制：同一草稿同一时间只允许一个校验任务
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from './config';
import { assertDiskSpace } from './disk';
import { logger } from './logger';
import {
  computeRevision,
  draftWorkspace,
  readDraft,
  updateDraft,
} from './drafts';
import type {
  UnibotValidationOutput,
  ValidationRun,
  ValidationStepId,
  ValidationStepResult,
} from './types';

const SERVER_ROOT = join(import.meta.dir, '..');
const VALIDATE_SCRIPT = join(SERVER_ROOT, 'validation', 'validate_extension.py');
const DEFAULT_STEP_ORDER: ValidationStepId[] = ['paths', 'manifest', 'syntax', 'ruff', 'tests', 'loader', 'dependencies'];
const STEP_NAMES: Record<ValidationStepId, string> = {
  paths: '路径与符号链接检查',
  manifest: 'Extension.toml 清单校验',
  syntax: 'Python 语法与 import 边界',
  ruff: 'Ruff lint + format',
  tests: '扩展自带测试',
  loader: 'Loader 绑定',
  dependencies: '依赖声明检查',
};

const RUNNING = new Set<string>();
/** 全局并发上限：每管理员同时最多一个校验任务（Plan 8.2） */
const MAX_CONCURRENT_VALIDATIONS = 1;

export interface ValidationStepConfig {
  id: ValidationStepId;
  name: string;
  enabled: boolean;
  order: number;
}

function stepsFile(): string {
  return join(config.data_dir, 'config', 'validation_steps.json');
}

/** 读取校验步骤配置（config/validation_steps.json；缺省全部启用，按默认顺序） */
function loadStepConfig(): ValidationStepConfig[] {
  const file = stepsFile();
  if (existsSync(file)) {
    try {
      const disk = JSON.parse(readFileSync(file, 'utf-8')) as ValidationStepConfig[];
      if (Array.isArray(disk) && disk.length) {
        // 与默认表合并（补充新登记步骤）
        return DEFAULT_STEP_ORDER.map((id, order) => {
          const saved = disk.find((s) => s.id === id);
          if (!saved) return { id, name: STEP_NAMES[id], enabled: true, order };
          return { id, name: STEP_NAMES[id], enabled: saved.enabled !== false, order: saved.order ?? order };
        }).sort((a, b) => a.order - b.order);
      }
    } catch {
      // 配置损坏时回退默认
    }
  }
  return DEFAULT_STEP_ORDER.map((id, order) => ({ id, name: STEP_NAMES[id], enabled: true, order }));
}

function persistStepConfig(steps: ValidationStepConfig[]): void {
  const file = stepsFile();
  mkdirSync(file.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(file, JSON.stringify(steps, null, 2) + '\n', 'utf-8');
}

let cachedSteps: ValidationStepConfig[] | null = null;

/** 校验步骤配置（供 /api/studio/validation/steps 展示与编排） */
export function validationStepsConfig(): ValidationStepConfig[] {
  if (!cachedSteps) cachedSteps = loadStepConfig();
  return cachedSteps.map((s) => ({ ...s }));
}

/** 更新校验步骤编排（启停 + 排序，持久化到 config/validation_steps.json） */
export function updateValidationSteps(steps: ValidationStepConfig[]): ValidationStepConfig[] {
  if (!Array.isArray(steps)) return validationStepsConfig();
  const next = DEFAULT_STEP_ORDER.map((id, order) => {
    const incoming = steps.find((s) => s.id === id);
    if (!incoming) return { id, name: STEP_NAMES[id], enabled: true, order };
    const savedOrder = Number.isFinite(incoming.order) ? incoming.order : order;
    return {
      id,
      name: STEP_NAMES[id],
      enabled: incoming.enabled !== false,
      order: savedOrder,
    };
  }).sort((a, b) => a.order - b.order);
  cachedSteps = next;
  persistStepConfig(next);
  return next.map((s) => ({ ...s }));
}

/** 当前生效的步骤顺序（仅启用项） */
function effectiveStepOrder(): ValidationStepId[] {
  return validationStepsConfig()
    .filter((s) => s.enabled)
    .sort((a, b) => a.order - b.order)
    .map((s) => s.id);
}

export function isValidationRunning(draftId: string): boolean {
  return RUNNING.has(draftId);
}

/** 路径安全预检（JS 侧，先于 Python 子进程执行） */
function checkPaths(extRoot: string): ValidationStepResult {
  const start = Date.now();
  const root = extRoot;

  const result: ValidationStepResult = {
    id: 'paths',
    name: STEP_NAMES.paths,
    status: 'passed',
    duration_ms: 0,
    started_at: new Date().toISOString(),
  };
  const errors: string[] = [];
  let fileCount = 0;
  let totalSize = 0;

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        errors.push(`不允许符号链接：${relative(root, full)}`);
        continue;
      }
      if (st.isDirectory()) walk(full);
      else {
        fileCount += 1;
        totalSize += statSync(full).size;
      }
    }
  };
  walk(root);

  if (fileCount === 0) errors.push('扩展目录为空');
  if (fileCount > 200) errors.push(`文件数 ${fileCount} 超过上限 200`);
  if (totalSize > 5 * 1024 * 1024) errors.push(`总大小 ${(totalSize / 1024 / 1024).toFixed(1)}MB 超过上限 5MB`);
  if (!existsSync(join(root, 'Extension.toml'))) errors.push('缺少 Extension.toml');
  if (!existsSync(join(root, '__init__.py'))) errors.push('缺少 __init__.py');

  result.duration_ms = Date.now() - start;
  result.finished_at = new Date().toISOString();
  if (errors.length) {
    result.status = 'failed';
    result.message = `${errors.length} 个问题`;
    result.detail = errors.join('\n');
  }
  return result;
}

/** 运行一次完整校验，返回校验运行记录（异步，供轮询） */
export async function runValidation(draftId: string): Promise<ValidationRun> {
  if (RUNNING.has(draftId)) {
    throw new Error('该校验已在进行中');
  }
  if (RUNNING.size >= MAX_CONCURRENT_VALIDATIONS) {
    throw new Error('已有校验任务进行中，请稍后再试');
  }
  // 校验前检查磁盘空间（Plan 11）
  assertDiskSpace(config.data_dir, '运行校验');
  RUNNING.add(draftId);
  const draft = readDraft(draftId);
  const revision = computeRevision(draftId);
  const stepOrder = effectiveStepOrder();
  logger.info('validation', '开始校验', {
    draft_id: draftId,
    extension_id: draft.extension_id,
    revision,
    steps: stepOrder,
  });

  const run: ValidationRun = {
    id: randomUUID(),
    status: 'running',
    steps: stepOrder.map((id) => ({
      id,
      name: STEP_NAMES[id],
      status: 'pending' as const,
      duration_ms: 0,
    })),
    started_at: new Date().toISOString(),
    revision,
  };

  // 步骤 1：路径预检（JS 侧，指向扩展目录而非 workspace 根）
  const extDir = join(draftWorkspace(draftId), draft.extension_id);
  const pathsIdx = run.steps.findIndex((s) => s.id === 'paths');
  if (pathsIdx >= 0) run.steps[pathsIdx] = checkPaths(extDir);
  updateDraft(draftId, { status: 'checking', validation: run });

  // 剩余步骤：Python 工具链（受限子进程）
  const pythonBin = join(config.unibot_dir, '.venv', 'bin', 'python');
  const { ok } = await runPythonSteps(pythonBin, extDir, run);
  run.status = ok ? 'passed' : 'failed';
  run.finished_at = new Date().toISOString();

  const failedSteps = run.steps.filter((s) => s.status === 'failed').map((s) => s.id);
  logger.info('validation', `校验${run.status === 'passed' ? '通过' : '失败'}`, {
    draft_id: draftId,
    extension_id: draft.extension_id,
    status: run.status,
    duration_ms: run.steps.reduce((acc, s) => acc + s.duration_ms, 0),
    failed_steps: failedSteps,
  });

  if (run.status === 'passed') {
    // 校验通过：摘要与校验记录关联；是否自动复核由调用方（maybeReviewAfterValidation）决定
    updateDraft(draftId, {
      status: 'ready',
      validation: run,
      validation_revision: revision,
    });
  } else {
    // 校验失败：保留结果展示，前端提供「自动修复」（repairing 分支）
    updateDraft(draftId, { status: 'checking', validation: run });
  }
  RUNNING.delete(draftId);
  return run;
}

/** 子进程调用 UniBot 校验脚本，逐步骤回填结果 */
function runPythonSteps(pythonBin: string, extDir: string, run: ValidationRun): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const args = [VALIDATE_SCRIPT, extDir, '--unibot-root', config.unibot_dir];
    // 清理环境变量：只保留 PATH 与必要项，不继承机器人 Token 等
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
    const child = spawn(pythonBin, args, {
      cwd: config.unibot_dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const start = Date.now();
    let settled = false;

    const finish = (steps: UnibotValidationOutput['steps']) => {
      if (settled) return;
      settled = true;
      for (const s of steps) {
        const idx = run.steps.findIndex((st) => st.id === s.id);
        if (idx >= 0 && run.steps[idx]) {
          run.steps[idx] = {
            id: s.id as ValidationStepId,
            name: STEP_NAMES[s.id as ValidationStepId] ?? s.name,
            status: s.ok ? 'passed' : 'failed',
            message: s.message,
            detail: s.detail,
            duration_ms: Math.round((Date.now() - start) / 1000),
            started_at: run.steps[idx].started_at,
            finished_at: new Date().toISOString(),
          };
        }
      }
      for (const st of run.steps) {
        if (st.status === 'pending' || st.status === 'running') {
          st.status = 'failed';
          st.message = st.message ?? '未执行';
          st.finished_at = new Date().toISOString();
        }
      }
      resolve({ ok: run.steps.every((st) => st.status === 'passed') });
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish([{ id: 'subprocess', name: '校验子进程', ok: false, message: '执行超时（120s）' }]);
    }, 120_000);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 128 * 1024) stdout = stdout.slice(-128 * 1024);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024);
    });
    child.on('error', (err) => {
      finish([{ id: 'subprocess', name: '校验子进程', ok: false, message: `无法启动校验进程：${err.message}` }]);
    });
    child.on('close', (code) => {
      const tail = (stdout + stderr).trim().split('\n').slice(-6).join('\n');
      // 校验脚本失败时退出码为 1，但 stdout 仍包含完整 JSON，优先解析 JSON
      const jsonLine = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      if (jsonLine) {
        try {
          const parsed = JSON.parse(jsonLine) as UnibotValidationOutput;
          finish(parsed.steps);
          return;
        } catch {
          // fallthrough
        }
      }
      if (code === 0) {
        finish([{ id: 'subprocess', name: '校验子进程', ok: false, message: '校验输出无法解析', detail: tail }]);
      } else {
        finish([{ id: 'subprocess', name: '校验子进程', ok: false, message: `校验子进程退出码 ${code}`, detail: tail }]);
      }
    });
  });
}
