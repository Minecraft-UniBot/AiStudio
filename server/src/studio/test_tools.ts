/**
 * 测试工具后端实现（对应 AGENT.md 3.5 / Plan.md 3.5）：
 * OpenCode 插件测试工具的「后端一半」——草稿部署/移除到测试环境、加载与绑定诊断、
 * 测试日志读取、测试运行。所有文件操作与子进程执行都在这里完成，插件只做参数转发。
 *
 * 安全边界（对应 AGENT.md 5.2 / 8.2）：
 * - 只允许操作测试环境（config.unibot_env.test_dir），禁止触碰正式 UniBot/Extensions
 * - 扩展 ID 必须与草稿一致（PascalCase），部署目标必须位于 test_dir/Extensions 内
 * - 复制前逐文件校验：拒绝符号链接、越界路径
 * - 子进程固定 cwd、清理环境变量、超时与输出上限（复用 unibot_env.runProcess）
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { config, validationScriptPath, unibotEnvPython } from './config';
import { draftWorkspace, readDraft } from './drafts';
import { logger } from './logger';
import { getUnibotEnvStatus, runProcess } from './unibot_env';
import type { ValidationRun } from './types';

export class TestToolsError extends Error {
  constructor(
    message: string,
    public code: string = 'TEST_TOOLS_ERROR',
  ) {
    super(message);
  }
}

/** 部署竞争锁（同一扩展 ID 并发部署/移除时拒绝第二个） */
const DEPLOY_LOCKS = new Set<string>();

function acquireLock(extensionId: string): boolean {
  if (DEPLOY_LOCKS.has(extensionId)) return false;
  DEPLOY_LOCKS.add(extensionId);
  return true;
}

function releaseLock(extensionId: string): void {
  DEPLOY_LOCKS.delete(extensionId);
}

/** 测试环境 Extensions 目录 */
function testExtensionsDir(): string {
  return join(config.unibot_env.test_dir, 'Extensions');
}

/** 校验部署目标路径：必须位于 test_dir/Extensions 内且扩展 ID 合法 */
function deployTarget(extensionId: string): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(extensionId)) {
    throw new TestToolsError('扩展 ID 必须为 PascalCase（如 WeatherExt）', 'INVALID_ID');
  }
  const base = resolve(testExtensionsDir());
  const target = resolve(join(base, extensionId));
  const rel = relative(base, target);
  if (rel.startsWith('..') || rel === '' || rel.split(sep).length !== 1) {
    throw new TestToolsError('部署目标越出测试环境 Extensions 目录', 'PATH_VIOLATION');
  }
  return target;
}

/** 深度校验目录：拒绝符号链接 */
function verifyTree(root: string, base: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new TestToolsError(`扩展包内不允许符号链接：${relative(base, full)}`, 'SYMLINK');
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
}

/** 测试日志目录（<data_dir>/logs/test/<ExtensionId>.log） */
function testLogFile(extensionId: string): string {
  return join(config.data_dir, 'logs', 'test', `${extensionId}.log`);
}

/** 追加一条测试日志（部署/加载/测试/校验都会记录） */
export function appendTestLog(extensionId: string, content: string): void {
  try {
    const file = testLogFile(extensionId);
    mkdirSync(join(config.data_dir, 'logs', 'test'), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(file, `\n===== ${stamp} =====\n${content}\n`, { flag: 'a', encoding: 'utf-8' });
  } catch (error) {
    logger.warn('test-tools', '写入测试日志失败', { extension_id: extensionId, error: (error as Error).message });
  }
}

/** 读取测试日志尾部（默认 50 行） */
export function readTestLog(extensionId: string, lines = 50): { lines: string[]; file: string } {
  const file = testLogFile(extensionId);
  if (!existsSync(file)) return { lines: [], file };
  const all = readFileSync(file, 'utf-8').split('\n');
  return { lines: all.slice(-lines), file };
}

/** 测试环境状态 + 已部署扩展列表 */
export function testEnvOverview(): {
  env: ReturnType<typeof getUnibotEnvStatus>;
  deployed: string[];
} {
  const env = getUnibotEnvStatus();
  const deployed: string[] = [];
  const base = testExtensionsDir();
  if (env.state === 'ready' && existsSync(base)) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) deployed.push(entry.name);
    }
  }
  return { env, deployed };
}

/**
 * 由调用方标识解析草稿并核对扩展 ID：
 * - 插件（运行在 opencode 会话内）传 workspace = context.directory（草稿工作区）
 * - 前端面板传 draft_id
 */
function resolveDraft(input: { workspace?: string; draft_id?: string }, extensionId: string) {
  let draft;
  if (input.draft_id) {
    draft = readDraft(input.draft_id);
  } else if (input.workspace) {
    const ws = resolve(input.workspace);
    draft = listDraftIds()
      .map((id) => readDraft(id))
      .find((d) => resolve(draftWorkspace(d.id)) === ws);
    if (!draft) {
      throw new TestToolsError('无法从 workspace 解析草稿，请确认在草稿工作区内调用', 'DRAFT_NOT_FOUND');
    }
  } else {
    throw new TestToolsError('缺少草稿标识（draft_id 或 workspace）', 'DRAFT_NOT_FOUND');
  }
  if (draft.extension_id !== extensionId) {
    throw new TestToolsError(`扩展 ID 不一致：草稿为 ${draft.extension_id}，传入 ${extensionId}`, 'ID_MISMATCH');
  }
  return draft;
}

function listDraftIds(): string[] {
  const dir = join(config.data_dir, 'drafts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => existsSync(join(dir, name, 'draft.json')));
}

/** 草稿标识：插件传 workspace（会话目录），前端面板传 draft_id */
export interface DraftRef {
  workspace?: string;
  draft_id?: string;
}

/** 部署草稿扩展到测试环境（staging + 原子重命名，可覆盖已部署的同名扩展） */
export function deployToTestEnv(ref: DraftRef, extensionId: string): Record<string, unknown> {
  if (!acquireLock(extensionId)) {
    throw new TestToolsError('该扩展正在部署/移除中，请稍候', 'DEPLOY_BUSY');
  }
  try {
    const draft = resolveDraft(ref, extensionId);
    const env = getUnibotEnvStatus();
    if (env.state !== 'ready' || !env.venv_ready) {
      throw new TestToolsError('测试环境未就绪，请先同步测试环境（unibot_test_sync）', 'ENV_NOT_READY');
    }
    const source = join(draftWorkspace(draft.id), extensionId);
    if (!existsSync(source)) {
      throw new TestToolsError(`草稿工作区中不存在扩展目录：${extensionId}`, 'SOURCE_MISSING');
    }
    const target = deployTarget(extensionId);
    const staging = join(testExtensionsDir(), `.staging-${extensionId}`);
    mkdirSync(testExtensionsDir(), { recursive: true });
    rmSync(staging, { recursive: true, force: true });

    try {
      cpSync(source, staging, {
        recursive: true,
        dereference: false,
        errorOnExist: false,
        filter: (src) => {
          const name = src.split(sep).pop() ?? '';
          return name !== '__pycache__' && !name.startsWith('.');
        },
      });
      verifyTree(staging, staging);
      if (!existsSync(join(staging, 'Extension.toml'))) {
        throw new TestToolsError('扩展包缺少 Extension.toml', 'MANIFEST_MISSING');
      }
      const manifest = readFileSync(join(staging, 'Extension.toml'), 'utf-8');
      if (!manifest.includes(`id = "${extensionId}"`)) {
        throw new TestToolsError('Extension.toml 中的 id 与草稿不一致', 'MANIFEST_MISMATCH');
      }
      // 覆盖式部署：先移除旧目录再原子 rename（测试环境可随时重建）
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }

    const fileCount = countFiles(target);
    const message = `已部署 ${extensionId} 到测试环境 Extensions/（${fileCount} 个文件）`;
    appendTestLog(extensionId, message);
    logger.info('test-tools', '部署到测试环境', { extension_id: extensionId, target, files: fileCount });
    return { ok: true, extension_id: extensionId, target, files: fileCount, message };
  } finally {
    releaseLock(extensionId);
  }
}

/** 从测试环境移除扩展 */
export function undeployFromTestEnv(ref: DraftRef, extensionId: string): Record<string, unknown> {
  if (!acquireLock(extensionId)) {
    throw new TestToolsError('该扩展正在部署/移除中，请稍候', 'DEPLOY_BUSY');
  }
  try {
    resolveDraft(ref, extensionId);
    const target = deployTarget(extensionId);
    const existed = existsSync(target);
    if (existed) rmSync(target, { recursive: true, force: true });
    const message = existed ? `已从测试环境移除 ${extensionId}` : `${extensionId} 未部署，无需移除`;
    appendTestLog(extensionId, message);
    logger.info('test-tools', '从测试环境移除', { extension_id: extensionId, existed });
    return { ok: true, extension_id: extensionId, removed: existed, message };
  } finally {
    releaseLock(extensionId);
  }
}

/**
 * 在测试环境「加载」指定扩展：运行校验脚本的 loader 绑定步骤（只读诊断），
 * 输出与机械校验一致的结构化结果（{ ok, steps, extension_id }）。
 */
export async function loadInTestEnv(ref: DraftRef, extensionId: string): Promise<Record<string, unknown>> {
  const draft = resolveDraft(ref, extensionId);
  const env = getUnibotEnvStatus();
  if (env.state !== 'ready' || !env.venv_ready) {
    throw new TestToolsError('测试环境未就绪，请先同步测试环境（unibot_test_sync）', 'ENV_NOT_READY');
  }
  const target = deployTarget(extensionId);
  if (!existsSync(target)) {
    throw new TestToolsError(`测试环境中未部署 ${extensionId}，请先 unibot_deploy`, 'NOT_DEPLOYED');
  }
  const python = unibotEnvPython();
  const script = validationScriptPath();
  // --allow-in-root：允许校验位于测试环境根目录内的已部署副本（仅测试工具使用）
  const result = await runProcess(
    python,
    [script, target, '--unibot-root', config.unibot_env.test_dir, '--allow-in-root', '--steps', 'loader'],
    { cwd: config.unibot_env.test_dir, timeout_ms: 5 * 60_000 },
  );
  const parsed = parseScriptOutput(result.output, result.code);
  const summary = parsed.ok ? `加载成功：${parsed.summary}` : `加载失败：${parsed.summary}`;
  appendTestLog(extensionId, `${summary}\n${result.output.slice(-2000)}`);
  logger.info('test-tools', '测试环境加载诊断完成', {
    extension_id: extensionId,
    ok: parsed.ok,
    code: result.code,
  });
  return { ok: parsed.ok, extension_id: extensionId, steps: parsed.steps, summary: parsed.summary };
}

/** 在测试环境运行已部署扩展的自带 pytest（复用校验脚本 tests 步骤） */
export async function runTestsInTestEnv(ref: DraftRef, extensionId: string): Promise<Record<string, unknown>> {
  const draft = resolveDraft(ref, extensionId);
  const env = getUnibotEnvStatus();
  if (env.state !== 'ready' || !env.venv_ready) {
    throw new TestToolsError('测试环境未就绪，请先同步测试环境（unibot_test_sync）', 'ENV_NOT_READY');
  }
  const target = deployTarget(extensionId);
  if (!existsSync(target)) {
    throw new TestToolsError(`测试环境中未部署 ${extensionId}，请先 unibot_deploy`, 'NOT_DEPLOYED');
  }
  const python = unibotEnvPython();
  const script = validationScriptPath();
  const result = await runProcess(
    python,
    [script, target, '--unibot-root', config.unibot_env.test_dir, '--allow-in-root', '--steps', 'tests'],
    { cwd: config.unibot_env.test_dir, timeout_ms: 10 * 60_000 },
  );
  const parsed = parseScriptOutput(result.output, result.code);
  const summary = parsed.ok ? '测试通过' : '测试失败';
  appendTestLog(extensionId, `${summary}\n${result.output.slice(-4000)}`);
  logger.info('test-tools', '测试环境运行扩展测试完成', {
    extension_id: extensionId,
    ok: parsed.ok,
    code: result.code,
  });
  return { ok: parsed.ok, extension_id: extensionId, steps: parsed.steps, summary };
}

/** 对草稿运行与发布前一致的完整校验流水线（只读，复用 validation.ts 的入口） */
export async function validateDraft(ref: DraftRef, extensionId: string): Promise<ValidationRun> {
  const draft = resolveDraft(ref, extensionId);
  // 延迟 import 避免循环依赖（validation.ts 不依赖本模块）
  const { runValidation } = await import('./validation');
  const run = await runValidation(draft.id);
  const summary = run.status === 'passed' ? '校验通过' : '校验未通过';
  appendTestLog(extensionId, `${summary}\n${run.steps.map((s) => `[${s.status}] ${s.name}`).join('\n')}`);
  return run;
}

/** 解析校验脚本的结构化 JSON 输出 */
function parseScriptOutput(
  stdout: string,
  code: number,
): { ok: boolean; steps: Array<{ id: string; name: string; status: string; message?: string }>; summary: string } {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      ok: false,
      steps: [{ id: 'script', name: '校验执行', status: 'failed', message: stdout.slice(-400) }],
      summary: '校验脚本输出无法解析',
    };
  }
  const parsed = JSON.parse(jsonMatch[0]) as {
    ok?: boolean;
    error?: string;
    steps?: Array<{ id: string; name: string; ok: boolean; message?: string; detail?: string }>;
  };
  const steps = (parsed.steps ?? []).map((step) => ({
    id: step.id,
    name: step.name,
    status: step.ok ? 'passed' : 'failed',
    message: step.message ?? step.detail,
  }));
  const ok = (parsed.ok ?? false) && code === 0;
  const failed = steps.filter((s) => s.status === 'failed');
  const summary = ok
    ? '全部步骤通过'
    : failed.length
      ? failed.map((s) => `${s.name}：${s.message ?? '未通过'}`).join('；')
      : (parsed.error ?? '执行失败');
  return { ok, steps, summary };
}

function countFiles(root: string): number {
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (lstatSync(full).isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(root);
  return count;
}
