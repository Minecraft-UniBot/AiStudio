/**
 * 插件市场上传（对应 types.ts MarketStepId / MarketRun 与 Plan「市场发布」）。
 *
 * 流程：precheck → auth → scaffold → commit → repo → push → release → asset → market_pr
 * 全部通过 git / gh 命令行驱动（runProcess），不在后端内嵌 GitHub SDK：
 * - 本地 git：init / config / add / commit / tag / push（身份沿用用户全局 git config）
 * - GitHub 操作：gh CLI（repo create / release create / fork / pr create）
 * - 未登录引导：auth 步骤检测 git 身份、gh 可用性与登录态；未就绪时返回明确的
 *   登录指引（终端执行 `gh auth login`，或到「平台设置 → 插件市场」粘贴 GitHub PAT），
 *   前端据此引导用户完成登录后重试。
 *
 * 仓库脚手架按 Extension.Example 模板布局生成（templates.ts 缓存的 repo/ 目录）：
 *   Extension/           扩展源码（草稿工作区内容，zip 根即扩展内容）
 *   .github/workflows/   官方打包 workflow（release.yml：Release 发布后自动打包 zip 上传资产）
 *   .gitignore LICENSE   模板仓库级文件；README.md 按草稿信息生成
 *
 * 后台执行：startMarketPublish 立即返回初始 MarketRun，实际步骤在后台推进，
 * 每步完成后更新草稿元数据并通过 market.updated 事件广播（前端实时展示进度）。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { config, saveConfig } from '../core/config';
import { logger } from '../core/logger';
import { broadcast } from '../opencode/events';
import { computeRevision, draftWorkspace, readDraft, updateDraft } from './drafts';
import { downloadFile, runProcess } from './unibot_env';
import {
  UNIFIED_TEMPLATE_ID,
  copyTemplateRepoExtras,
  copyTree,
  pullTemplate,
  templateRepoExtrasAvailable,
} from './templates';
import type {
  DraftMeta,
  MarketRun,
  MarketStepId,
  MarketStepResult,
  StudioConfig,
} from '../core/types';

export class MarketError extends Error {
  constructor(
    message: string,
    public code: string = 'MARKET_ERROR',
  ) {
    super(message);
  }
}

/** 市场发布竞争锁：同一草稿并发上传直接拒绝（避免工作目录互相污染） */
const MARKET_LOCKS = new Set<string>();

/** 单次上传的运行上下文（跨步骤传递 staging 目录等内部状态） */
interface MarketContext {
  /** GitHub 登录账号（auth 步骤解析，owner/repo 用） */
  owner: string;
  /** 本地 git 仓库目录（scaffold 步骤创建，commit/repo/push/release 步骤复用） */
  stagingDir: string;
  /** 扩展源码仓库 owner/repo */
  repo: string;
  /** 发布版本号（读自 Extension.toml） */
  version: string;
  /** Release tag（v<version>） */
  tag: string;
  /** 市场注册表 fork 的本地克隆目录（market_pr 步骤使用） */
  registryDir: string;
}

/** 步骤定义（顺序即执行顺序） */
const STEP_DEFS: Array<{ id: MarketStepId; name: string }> = [
  { id: 'precheck', name: '机械校验核对' },
  { id: 'auth', name: 'GitHub 登录态' },
  { id: 'scaffold', name: '生成仓库脚手架（Extension.Example 模板）' },
  { id: 'commit', name: '本地 git 提交' },
  { id: 'repo', name: '确保 GitHub 仓库存在' },
  { id: 'push', name: '推送源码到 GitHub' },
  { id: 'release', name: '创建 Release（触发打包工作流）' },
  { id: 'asset', name: '等待打包资产上传' },
  { id: 'market_pr', name: '提交市场注册 Pull Request' },
];

function stepResult(
  id: MarketStepId,
  status: MarketStepResult['status'],
  opts: { message?: string; detail?: string; duration_ms?: number } = {},
): MarketStepResult {
  return {
    id,
    name: STEP_DEFS.find((s) => s.id === id)?.name ?? id,
    status,
    message: opts.message,
    detail: opts.detail,
    duration_ms: opts.duration_ms ?? 0,
  };
}

/** 创建初始 MarketRun（全部步骤 pending） */
function createRun(): MarketRun {
  return {
    id: randomUUID(),
    status: 'running',
    steps: STEP_DEFS.map((s) => stepResult(s.id, 'pending')),
    repo: null,
    version: null,
    release_tag: null,
    release_url: null,
    pr_url: null,
    started_at: new Date().toISOString(),
  };
}

/** 落盘 MarketRun 并广播 market.updated 事件（每个步骤状态变化后调用） */
function persistRun(draftId: string, run: MarketRun): void {
  updateDraft(draftId, { market: run });
  broadcast({ type: 'market.updated', draft_id: draftId, run });
}

/**
 * 执行单个步骤：置 running → 执行 → 置 passed / failed。
 * 失败时抛错终止整个流程（由 executeMarketRun 统一收尾）。
 */
async function runStep(
  draftId: string,
  run: MarketRun,
  id: MarketStepId,
  fn: () => Promise<{ message?: string; detail?: string } | void>,
): Promise<void> {
  const started = Date.now();
  const idx = run.steps.findIndex((s) => s.id === id);
  run.steps[idx] = stepResult(id, 'running');
  persistRun(draftId, run);
  try {
    const extra = await fn();
    const result = stepResult(id, 'passed', {
      message: extra?.message,
      detail: extra?.detail,
      duration_ms: Date.now() - started,
    });
    run.steps[idx] = result;
  } catch (e) {
    const err = e as Error;
    const result = stepResult(id, 'failed', {
      message: err.message,
      detail: err instanceof MarketError ? err.code : undefined,
      duration_ms: Date.now() - started,
    });
    run.steps[idx] = result;
    throw err;
  }
  persistRun(draftId, run);
}

// ===== git / gh 命令行封装 =====

/** gh 命令环境：配置了 token 时以 GH_TOKEN 注入（优先级高于 gh 本地登录态）；始终禁用交互提示 */
function ghEnv(): Record<string, string> {
  const env: Record<string, string> = { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
  if (config.market.token) env.GH_TOKEN = config.market.token;
  return env;
}

/**
 * 探测系统代理（gh 是 Go 程序，默认不读 macOS 系统代理，需显式注入 HTTPS_PROXY 才能连通 GitHub）：
 * 优先读环境变量，其次 macOS 用 scutil --proxy 解析；探测不到返回 null。
 */
function detectHttpsProxy(): string | null {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (fromEnv) return fromEnv;
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync('scutil', ['--proxy'], { encoding: 'utf-8', timeout: 3000 });
      const host = raw.match(/HTTPSProxy\s*:\s*([^\s]+)/);
      const port = raw.match(/HTTPSPort\s*:\s*(\d+)/);
      const enabled = /HTTPSEnable\s*:\s*1/.test(raw);
      if (enabled && host && port) return `http://${host[1]}:${port[1]}`;
    } catch {
      // scutil 不可用/超时：保持 null
    }
  }
  return null;
}

/** gh 可执行文件名（Windows 带 .exe 后缀） */
function ghBinName(): string {
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

/** installGhCli 的安装目录（~/.local/share/gh-cli/bin） */
function ghInstallDir(): string {
  return join(homedir(), '.local', 'share', 'gh-cli', 'bin');
}

/** 已安装的 gh 可执行文件绝对路径（installGhCli 安装到 ghInstallDir()） */
function ghInstallBinPath(): string {
  return join(ghInstallDir(), ghBinName());
}

/**
 * 解析 gh 可执行文件路径：优先用 installGhCli 安装的绝对路径（即使不在 PATH 中也能用），
 * 否则回退到 PATH 中的 'gh'。
 */
function ghBinPath(): string {
  const installed = ghInstallBinPath();
  return existsSync(installed) ? installed : 'gh';
}

/** 运行 gh 命令（输出合并 stdout/stderr；code !== 0 表示失败） */
function gh(args: string[], options: { cwd?: string; timeout_ms?: number } = {}) {
  return runProcess(ghBinPath(), args, { cwd: options.cwd, timeout_ms: options.timeout_ms, env: ghEnv() });
}

/** git push 的鉴权参数：token 模式通过 http.extraHeader 注入（不把 token 写进 remote URL/磁盘） */
function gitAuthArgs(): string[] {
  if (!config.market.token) return [];
  const basic = Buffer.from(`x-access-token:${config.market.token}`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

/** 运行 git 命令（追加 token 鉴权参数与禁交互环境） */
function git(args: string[], options: { cwd?: string; timeout_ms?: number } = {}) {
  return runProcess('git', [...gitAuthArgs(), ...args], {
    cwd: options.cwd,
    timeout_ms: options.timeout_ms,
    env: ghEnv(),
  });
}

// ===== 登录态检测（前端市场设置 / auth 步骤共用） =====

export interface MarketStatus {
  /** 是否具备上传条件（git 身份 + gh CLI 可用 + GitHub 登录 + 可解析 owner） */
  ready: boolean;
  git_configured: boolean;
  gh_available: boolean;
  gh_authed: boolean;
  /** 是否已通过平台设置配置 GitHub PAT */
  token_configured: boolean;
  /** token 末 4 位（展示用，永不下发明文） */
  token_tail: string | null;
  /** 实际采用的认证来源（token 优先于 gh 本地登录态） */
  auth_source: 'token' | 'gh' | null;
  /** 解析出的 GitHub 账号（config.market.owner > gh api user > token 拉取） */
  owner: string | null;
  repo_visibility: 'public' | 'private';
  market_repo: string;
  /** 未就绪时的登录/配置指引（前端展示） */
  guidance: string | null;
}

/** 从 gh / GitHub API 解析当前登录账号（config.market.owner 优先，可被环境变量覆盖） */
async function resolveOwner(): Promise<string | null> {
  if (config.market.owner) return config.market.owner;
  const who = await gh(['api', 'user', '--jq', '.login']);
  if (who.code === 0) {
    const login = who.output.trim();
    if (login) return login;
  }
  // gh 不可用但配置了 token：走 GitHub REST API 兜底
  if (config.market.token) {
    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${config.market.token}`,
          'User-Agent': 'unibot-extension-studio',
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { login?: string };
        if (data.login) return data.login;
      }
    } catch {
      // 离线/限流：保持 null，由 auth 步骤给出明确失败原因
    }
  }
  return null;
}

/** 未就绪时的登录指引文案 */
function buildGuidance(
  gitConfigured: boolean,
  ghAvailable: boolean,
  ghAuthed: boolean,
  tokenConfigured: boolean,
): string {
  const lines: string[] = [];
  if (!gitConfigured) {
    lines.push(
      '未检测到本地 git 身份。请在「平台设置 → 插件市场」填写 GitHub 账号（owner）即可，发布时自动以该账号身份提交。',
    );
  }
  if (!ghAvailable) {
    lines.push(
      '未安装 GitHub CLI（gh）。请点击「自动安装」下载当前系统的安装包；安装后在下方粘贴 GitHub Personal Access Token（需 repo 与 workflow 权限）即可，无需在终端登录。',
    );
  } else if (!ghAuthed && !tokenConfigured) {
    lines.push(
      'gh 未登录。点击下方「登录 GitHub」后台完成授权；或粘贴 Personal Access Token（需 repo 与 workflow 权限）作为替代。',
    );
  }
  return lines.join('\n');
}

/** 检测市场上传前置条件（git 身份 / gh 登录 / token 配置 / owner 解析） */
export async function getMarketStatus(): Promise<MarketStatus> {
  const gitName = await runProcess('git', ['config', '--get', 'user.name'], { env: ghEnv() });
  const gitEmail = await runProcess('git', ['config', '--get', 'user.email'], { env: ghEnv() });
  const gitConfigured = gitName.code === 0 && gitEmail.code === 0;

  // 用 ghBinPath() 探测：installGhCli 安装的绝对路径即使不在 PATH 中也能识别为可用
  const ghProbe = await runProcess(ghBinPath(), ['--version'], { env: ghEnv() });
  const ghAvailable = ghProbe.code === 0;
  const ghAuth = ghAvailable
    ? await runProcess(ghBinPath(), ['auth', 'status'], { env: ghEnv() })
    : { code: 1, output: '' };
  const ghAuthed = ghAuth.code === 0;

  const tokenConfigured = Boolean(config.market.token);
  const tokenTail = tokenConfigured ? config.market.token.slice(-4) : null;
  const auth_source = tokenConfigured ? 'token' : ghAuthed ? 'gh' : null;

  // gh CLI 是 repo create / release / fork / pr 的执行载体：未安装时即使配置了
  // token 也不算就绪（否则上传会在中途失败），引导用户先安装 gh。
  const owner = auth_source ? await resolveOwner() : null;
  // 认证来源已是 'token' 时不要求 gh 本地登录态；git 身份缺失时提交会自动回退为
  // owner 的 noreply 邮箱（见 executeMarketRun commit 步骤），因此不作为硬性门槛。
  const ready = Boolean(ghAvailable && auth_source && owner);
  const guidance = ready ? null : buildGuidance(gitConfigured, ghAvailable, ghAuthed, tokenConfigured);

  return {
    ready,
    git_configured: gitConfigured,
    gh_available: ghAvailable,
    gh_authed: ghAuthed,
    token_configured: tokenConfigured,
    token_tail: tokenTail,
    auth_source,
    owner,
    repo_visibility: config.market.repo_visibility,
    market_repo: config.market.market_repo,
    guidance,
  };
}

/**
 * 更新市场配置（仅经专用市场接口调用，通用 PATCH /settings 会剥离 market 段）。
 * token 仅存本地 config 文件；接口只返回脱敏状态，永不下发明文。
 */
export async function saveMarketConfig(patch: {
  owner?: string;
  token?: string;
  repo_visibility?: 'public' | 'private';
}): Promise<MarketStatus> {
  const next: StudioConfig['market'] = {
    ...config.market,
    ...(patch.owner !== undefined ? { owner: patch.owner.trim() } : {}),
    ...(patch.token !== undefined ? { token: patch.token.trim() } : {}),
    ...(patch.repo_visibility !== undefined
      ? { repo_visibility: patch.repo_visibility }
      : {}),
  };
  saveConfig({ market: next });
  logger.info('market', '市场配置已更新', {
    owner: next.owner,
    token_tail: next.token ? next.token.slice(-4) : null,
    repo_visibility: next.repo_visibility,
  });
  return getMarketStatus();
}

// ===== 脚手架（Extension.Example 模板布局） =====

/** 从草稿 Extension.toml 读取版本号（轻量正则，字段在清单固定位置） */
export function readManifestVersion(workspace: string, extensionId: string): string | null {
  try {
    const text = readFileSync(join(workspace, extensionId, 'Extension.toml'), 'utf-8');
    return text.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 按草稿信息生成仓库 README.md（模板 README 面向 Example 扩展，不直接复用） */
export function renderRepoReadme(draft: DraftMeta, repo: string): string {
  return [
    `# ${draft.name}`,
    '',
    draft.description || `UniBot 扩展：${draft.extension_id}。`,
    '',
    '## 目录结构',
    '',
    '```text',
    'Extension/',
    '├── Extension.toml      # 清单：声明类型、依赖与版本',
    '├── __init__.py         # 入口',
    '└── ...',
    '```',
    '',
    '## 市场发布',
    '',
    '本仓库已内置官方打包工作流（`.github/workflows/release.yml`）：创建 GitHub Release 后',
    '自动把 `Extension/` 打包为 `<id>-<version>.zip` 并上传为 Release 资产，市场注册表定时抓取。',
    '',
    '> 由 Extension Studio 生成；发布到 UniBot 插件市场后，用户可在 WebUI「插件市场」搜索安装。',
    '',
  ].join('\n');
}

// ===== 发布流程 =====

/**
 * 启动市场上传（后台执行）。
 * 校验通过（precheck）且登录就绪（auth）的草稿，按 Extension.Example 模板生成仓库并
 * 推送到 GitHub，创建 Release 触发打包工作流，最后向市场仓库提交注册 Pull Request。
 * 立即返回初始 MarketRun；后续进度经 market.updated 事件推送。
 */
export function startMarketPublish(draftId: string): MarketRun {
  const draft = readDraft(draftId);
  if (draft.market?.status === 'running') {
    throw new MarketError('该草稿正在进行市场发布，请稍候', 'MARKET_BUSY');
  }
  if (MARKET_LOCKS.has(draftId)) {
    throw new MarketError('该草稿正在进行市场发布，请稍候', 'MARKET_BUSY');
  }
  MARKET_LOCKS.add(draftId);

  const run = createRun();
  persistRun(draftId, run);
  logger.info('market', '开始上传插件市场', {
    draft_id: draftId,
    extension_id: draft.extension_id,
  });
  void executeMarketRun(draftId, run);
  return run;
}

/** 后台执行全部市场步骤（带完整 try/finally：无论成败释放锁并收尾 run） */
async function executeMarketRun(draftId: string, run: MarketRun): Promise<void> {
  try {
    const draft = readDraft(draftId);
    const workspace = draftWorkspace(draftId);
    const extensionId = draft.extension_id;
    const ctx: Partial<MarketContext> = {};

    // ---- precheck：机械校验通过且文件摘要未过期 ----
    await runStep(draftId, run, 'precheck', async () => {
      const current = computeRevision(draftId);
      if (draft.validation?.status !== 'passed' || draft.validation_revision !== current) {
        throw new MarketError(
          '机械校验未通过或文件已变更，请重新检查后再上传市场',
          'VALIDATION_STALE',
        );
      }
      const version = readManifestVersion(workspace, extensionId);
      if (!version) {
        throw new MarketError('Extension.toml 缺少 version 字段，无法发布市场', 'NO_VERSION');
      }
      ctx.version = version;
      run.version = version;
      return { message: `机械校验通过（v${version}），文件摘要与检查时一致` };
    });

    // ---- auth：本地 git / GitHub 登录态 ----
    await runStep(draftId, run, 'auth', async () => {
      const status = await getMarketStatus();
      if (!status.ready || !status.owner) {
        throw new MarketError(
          status.guidance ?? 'GitHub 登录态不可用',
          'AUTH_REQUIRED',
        );
      }
      ctx.owner = status.owner;
      return {
        message: `GitHub 账号：${status.owner}（${status.auth_source === 'token' ? 'PAT 令牌' : 'gh 登录态'}）`,
      };
    });

    // ---- scaffold：按 Extension.Example 模板生成仓库 ----
    await runStep(draftId, run, 'scaffold', async () => {
      // 模板仓库级文件（.github/workflows 等）未缓存时先拉取模板（幂等）
      if (!templateRepoExtrasAvailable(UNIFIED_TEMPLATE_ID)) {
        await pullTemplate(UNIFIED_TEMPLATE_ID);
      }
      const stagingDir = join(config.market.work_dir, `${extensionId}-${Date.now()}`);
      mkdirSync(stagingDir, { recursive: true });
      // 1. 扩展源码 → Extension/（zip 打包时以 Extension/ 为根，见模板 release.yml）
      copyTree(join(workspace, extensionId), join(stagingDir, 'Extension'));
      // 2. 仓库级文件：.github/workflows（打包 workflow）、LICENSE、.gitignore
      copyTemplateRepoExtras(UNIFIED_TEMPLATE_ID, stagingDir);
      // 3. README 按草稿信息生成
      writeFileSync(join(stagingDir, 'README.md'), renderRepoReadme(draft, ''), 'utf-8');
      ctx.stagingDir = stagingDir;
      return { message: `已生成仓库脚手架：Extension/ + 官方打包 workflow（${config.market.work_dir}）` };
    });

    // ---- commit：git init + 提交 ----
    await runStep(draftId, run, 'commit', async () => {
      const dir = ctx.stagingDir!;
      const init = await git(['init', '-q'], { cwd: dir });
      if (init.code !== 0) throw new MarketError(`git init 失败：${init.output.slice(-400)}`);
      // 全局 git 身份缺失时回退为 owner 的 noreply 邮箱（避免 commit 因身份缺失失败）
      const gitName = await runProcess('git', ['config', '--get', 'user.name']);
      const gitEmail = await runProcess('git', ['config', '--get', 'user.email']);
      if (gitName.code !== 0 || gitEmail.code !== 0) {
        const owner = ctx.owner!;
        await git(['config', 'user.name', owner], { cwd: dir });
        await git(['config', 'user.email', `${owner}@users.noreply.github.com`], { cwd: dir });
      }
      const add = await git(['add', '-A'], { cwd: dir });
      if (add.code !== 0) throw new MarketError(`git add 失败：${add.output.slice(-400)}`);
      const commit = await git(['commit', '-q', '-m', `发布 ${extensionId} v${ctx.version}`], {
        cwd: dir,
      });
      if (commit.code !== 0) {
        throw new MarketError(`git commit 失败：${commit.output.slice(-400)}`);
      }
      // 统一默认分支为 main（模板仓库与 PR 都以 main 为基）
      await git(['branch', '-M', 'main'], { cwd: dir });
      return { message: `已提交 ${extensionId} v${ctx.version}` };
    });

    // ---- repo：确保 GitHub 仓库存在（不存在则创建，可见性取配置） ----
    await runStep(draftId, run, 'repo', async () => {
      const repo = `${ctx.owner}/${extensionId}`;
      ctx.repo = repo;
      const view = await gh(['repo', 'view', repo, '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
      if (view.code === 0) {
        return { message: `仓库已存在：${repo}` };
      }
      const created = await gh(
        // 不带 --confirm（gh 2.4+ 已移除该标志）；name/visibility/source 齐备时本就非交互
        ['repo', 'create', repo, `--${config.market.repo_visibility}`, '--source', ctx.stagingDir!, '--remote', 'origin'],
        { timeout_ms: 60_000 },
      );
      if (created.code !== 0) {
        throw new MarketError(`创建 GitHub 仓库失败：${created.output.slice(-400)}`);
      }
      return { message: `已创建仓库：${repo}（${config.market.repo_visibility}）` };
    });

    // ---- push：推送到 GitHub ----
    await runStep(draftId, run, 'push', async () => {
      const dir = ctx.stagingDir!;
      // gh repo create --source 已配置 origin；老仓库/重试场景缺失时补齐
      const remote = await git(['remote', 'get-url', 'origin'], { cwd: dir });
      if (remote.code !== 0) {
        const url = `https://github.com/${ctx.repo}.git`;
        const add = await git(['remote', 'add', 'origin', url], { cwd: dir });
        if (add.code !== 0) throw new MarketError(`添加 remote 失败：${add.output.slice(-400)}`);
      }
      const pushed = await git(['push', '-u', 'origin', 'main'], { cwd: dir, timeout_ms: 120_000 });
      if (pushed.code !== 0) {
        throw new MarketError(`推送源码失败：${pushed.output.slice(-400)}`);
      }
      return { message: `已推送到 github.com/${ctx.repo} (main)` };
    });

    // ---- release：创建 tag + GitHub Release（触发仓库 release.yml 打包） ----
    await runStep(draftId, run, 'release', async () => {
      const dir = ctx.stagingDir!;
      const tag = `v${ctx.version}`;
      ctx.tag = tag;
      run.release_tag = tag;
      // tag 已存在时 gh release create 会失败 → 复用已有 Release（重跑场景）
      const existing = await gh(['release', 'view', tag, '--repo', ctx.repo!, '--json', 'url', '--jq', '.url']);
      if (existing.code === 0) {
        run.release_url = existing.output.trim();
        return { message: `Release 已存在：${tag}` };
      }
      // 确保 tag 推送到远端
      const tagLocal = await git(['tag', tag], { cwd: dir });
      if (tagLocal.code === 0) {
        const tagPush = await git(['push', 'origin', tag], { cwd: dir, timeout_ms: 60_000 });
        if (tagPush.code !== 0) {
          throw new MarketError(`推送 tag 失败：${tagPush.output.slice(-400)}`);
        }
      } else {
        // tag 已存在本地：保证远端同步
        await git(['push', 'origin', tag], { cwd: dir, timeout_ms: 60_000 });
      }
      const notes = `由 Extension Studio 自动发布：${draft.name} v${ctx.version}\n\n上传市场后由仓库工作流自动打包扩展资产。`;
      const created = await gh(
        ['release', 'create', tag, '--repo', ctx.repo!, '--title', `${draft.name} v${ctx.version}`, '--notes', notes],
        { timeout_ms: 60_000 },
      );
      if (created.code !== 0) {
        throw new MarketError(`创建 Release 失败：${created.output.slice(-400)}`);
      }
      const url = await gh(['release', 'view', tag, '--repo', ctx.repo!, '--json', 'url', '--jq', '.url']);
      run.release_url = url.code === 0 ? url.output.trim() : `https://github.com/${ctx.repo}/releases/tag/${tag}`;
      return { message: `已创建 Release ${tag}（打包工作流已触发）` };
    });

    // ---- asset：等待打包工作流上传 zip 资产（超时不阻断） ----
    await runStep(draftId, run, 'asset', async () => {
      const assetName = `${extensionId}-${ctx.version}.zip`;
      const deadline = Date.now() + config.market.asset_timeout_ms;
      let found = false;
      while (Date.now() < deadline) {
        const assets = await gh(
          ['release', 'view', ctx.tag!, '--repo', ctx.repo!, '--json', 'assets', '--jq', '.assets[].name'],
          { timeout_ms: 30_000 },
        );
        if (assets.code === 0 && assets.output.split('\n').map((s) => s.trim()).includes(assetName)) {
          found = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      return {
        message: found
          ? `打包资产已上传：${assetName}`
          : '打包资产仍在生成中（工作流较慢，超时未阻断；市场定时任务会稍后抓取）',
      };
    });

    // ---- market_pr：fork 市场仓库 → 提交元数据 → 创建/复用 Pull Request ----
    await runStep(draftId, run, 'market_pr', async () => {
      const marketRepo = config.market.market_repo;
      const marketBranch = config.market.market_branch;
      const marketName = marketRepo.split('/').pop()!;
      const prBranch = `add-${extensionId}-${ctx.version}`;
      const forkRepo = `${ctx.owner}/${marketName}`;

      // 1. fork 市场仓库（已存在 fork 时 gh 报错，忽略即可）
      const fork = await gh(['repo', 'fork', marketRepo, '--clone=false'], { timeout_ms: 60_000 });
      if (fork.code !== 0 && !/already exists/i.test(fork.output)) {
        throw new MarketError(`Fork 市场仓库失败：${fork.output.slice(-400)}`);
      }
      // 2. 克隆 fork（本地工作目录，带 token 鉴权）
      const registryDir = join(config.market.work_dir, `market-${marketName}-${Date.now()}`);
      mkdirSync(dirname(registryDir), { recursive: true });
      const clone = await git(
        ['clone', '-q', `https://github.com/${forkRepo}.git`, registryDir],
        { timeout_ms: 120_000 },
      );
      if (clone.code !== 0) {
        throw new MarketError(`克隆市场仓库失败：${clone.output.slice(-400)}`);
      }
      ctx.registryDir = registryDir;

      // 3. 检出分支 + 写入元数据
      const checkout = await git(['checkout', '-q', '-b', prBranch], { cwd: registryDir });
      if (checkout.code !== 0) throw new MarketError(`创建分支失败：${checkout.output.slice(-400)}`);
      const metaDir = join(registryDir, 'extensions');
      mkdirSync(metaDir, { recursive: true });
      const metadata = {
        id: extensionId,
        name: draft.name,
        repo: ctx.repo,
        description: draft.description,
        official: false,
      };
      writeFileSync(join(metaDir, `${extensionId}.json`), JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
      await git(['add', 'extensions'], { cwd: registryDir });
      const commit = await git(
        ['commit', '-q', '-m', `添加扩展 ${extensionId} v${ctx.version}（Extension Studio 自动提交）`],
        { cwd: registryDir },
      );
      if (commit.code !== 0) {
        throw new MarketError(`提交市场元数据失败：${commit.output.slice(-400)}`);
      }
      // 4. 推送分支到 fork
      const pushed = await git(['push', '-u', 'origin', prBranch], { cwd: registryDir, timeout_ms: 120_000 });
      if (pushed.code !== 0) {
        throw new MarketError(`推送市场元数据分支失败：${pushed.output.slice(-400)}`);
      }
      // 5. 创建 PR（同分支已有 open PR 时复用）
      const prList = await gh(
        ['pr', 'list', '--repo', marketRepo, '--head', `${ctx.owner}:${prBranch}`, '--state', 'open', '--json', 'url', '--jq', '.[0].url'],
      );
      if (prList.code === 0 && prList.output.trim()) {
        run.pr_url = prList.output.trim();
        return { message: `Pull Request 已存在：${run.pr_url}` };
      }
      const body =
        `由 Extension Studio 自动提交的扩展市场注册。\n\n` +
        `- 扩展：**${draft.name}**（\`${extensionId}\`）\n` +
        `- 源码仓库：\`${ctx.repo}\`\n` +
        `- 版本：\`v${ctx.version}\`\n\n` +
        `工作流将校验元数据格式并从源码仓库拉取 Release 验证可构建。`;
      const prCreated = await gh(
        ['pr', 'create', '--repo', marketRepo, '--base', marketBranch, '--head', `${ctx.owner}:${prBranch}`, '--title', `添加扩展：${draft.name}（${extensionId}）`, '--body', body],
        { timeout_ms: 60_000 },
      );
      if (prCreated.code !== 0) {
        throw new MarketError(`创建 Pull Request 失败：${prCreated.output.slice(-400)}`);
      }
      run.pr_url = prCreated.output.trim();
      return { message: `已创建 Pull Request：${run.pr_url}` };
    });

    // ---- 全部通过：收尾 ----
    run.status = 'submitted';
    run.repo = ctx.repo ?? null;
    run.finished_at = new Date().toISOString();
    persistRun(draftId, run);
    logger.info('market', '市场上传提交成功', {
      draft_id: draftId,
      extension_id: extensionId,
      repo: run.repo,
      version: run.version,
      release_url: run.release_url,
      pr_url: run.pr_url,
    });
  } catch (e) {
    const err = e as Error;
    run.status = 'failed';
    run.error = err.message;
    run.finished_at = new Date().toISOString();
    persistRun(draftId, run);
    logger.error('market', '市场上传失败', { draft_id: draftId, error: err.message });
  } finally {
    MARKET_LOCKS.delete(draftId);
    // 清理临时目录（工作目录保留最新一次，便于排查）
    void cleanupWorkDirs();
  }
}

/** 清理市场工作目录下的临时产物（保留最近一次，避免无限堆积） */
async function cleanupWorkDirs(): Promise<void> {
  try {
    const root = config.market.work_dir;
    if (!existsSync(root)) return;
    const entries = (await import('node:fs')).readdirSync(root);
    const dirs = entries
      .filter((name) => {
        const full = join(root, name);
        try {
          return statSync(full).isDirectory();
        } catch {
          return false;
        }
      })
      .map((name) => ({ name, mtime: statSync(join(root, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    // 保留最近 3 个目录，其余删除
    for (const dir of dirs.slice(3)) {
      rmSync(join(root, dir.name), { recursive: true, force: true });
    }
  } catch {
    // 清理失败不影响主流程
  }
}

// ===== GitHub CLI 安装（gh 未安装时从 cli/cli releases 拉取当前系统安装包） =====

export interface GhInstallInfo {
  /** 当前系统平台（darwin/linux/win32） */
  platform: string;
  /** 当前系统架构（x64/arm64） */
  arch: string;
  /** 匹配的资产文件名（未找到为 null） */
  asset_name: string | null;
  /** 资产下载地址 */
  download_url: string | null;
  /** 最新版本号（如 2.62.0） */
  version: string | null;
  /** 安装目标目录（gh 可执行文件所在目录） */
  install_dir: string;
  /** 安装后的 gh 可执行文件绝对路径 */
  bin_path: string;
  /** 安装目录是否已加入 PATH（未加入时前端提示用户手动加入） */
  in_path: boolean;
}

/** gh CLI 资产命名中的平台段（gh_<ver>_<os>_<arch>.<ext>） */
function ghAssetPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

/** gh CLI 资产命名中的架构段（amd64/arm64） */
function ghAssetArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    default:
      return arch;
  }
}

/** 检测当前系统对应的 gh CLI 安装信息（从 cli/cli 最新 release 匹配资产） */
export async function getGhInstallInfo(): Promise<GhInstallInfo> {
  const platform = ghAssetPlatform(process.platform);
  const arch = ghAssetArch(process.arch);
  const installDir = ghInstallDir();
  const binPath = ghInstallBinPath();
  // PATH 分隔符跨平台（POSIX ':' / Windows ';'），用 path.delimiter 判断安装目录是否已加入 PATH
  const inPath = process.env.PATH?.split(delimiter).some((p) => resolve(p) === installDir) ?? false;

  const info: GhInstallInfo = {
    platform,
    arch,
    asset_name: null,
    download_url: null,
    version: null,
    install_dir: installDir,
    bin_path: binPath,
    in_path: inPath,
  };

  try {
    const response = await fetch('https://api.github.com/repos/cli/cli/releases/latest', {
      headers: { 'User-Agent': 'unibot-extension-studio', Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return info;
    const data = (await response.json()) as {
      tag_name?: string;
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    info.version = (data.tag_name ?? '').replace(/^v/, '') || null;
    // 优先 zip/tar.gz 便携包（macOS 的 .pkg 需 sudo 安装，不采用）；按平台+架构精确匹配
    const asset = (data.assets ?? []).find((item) => {
      const name = item.name ?? '';
      if (!name.includes(`_${platform}_${arch}`)) return false;
      return name.endsWith('.zip') || name.endsWith('.tar.gz');
    });
    if (asset?.name && asset.browser_download_url) {
      info.asset_name = asset.name;
      info.download_url = asset.browser_download_url;
    }
  } catch {
    // API 受限（限流/离线）：保持 asset 为 null，由前端提示稍后重试
  }
  return info;
}

/**
 * 安装 GitHub CLI（gh）：从 cli/cli 最新 release 拉取当前系统的便携安装包，
 * 解压出 bin/gh 可执行文件放到用户目录（~/.local/share/gh-cli/bin），无需 sudo。
 * 下载的安装包与解压临时目录均在 finally 中清理，不留残留。
 * 返回安装结果；安装目录未在 PATH 中时前端提示用户手动加入。
 */
export async function installGhCli(): Promise<GhInstallInfo> {
  const info = await getGhInstallInfo();
  if (!info.download_url || !info.asset_name) {
    throw new MarketError(
      `未找到当前系统（${info.platform}/${info.arch}）对应的 gh 安装包，请稍后重试或手动安装`,
      'GH_ASSET_NOT_FOUND',
    );
  }
  // 已安装则直接返回（幂等）
  if (existsSync(info.bin_path)) {
    return info;
  }

  // 用系统临时目录做下载/解压中转，finally 中整体清理（含安装包与解压产物）
  const staging = mkdtempSync(join(tmpdir(), 'unibot-gh-'));
  try {
    logger.info('market', '开始安装 GitHub CLI', {
      version: info.version,
      asset: info.asset_name,
      platform: info.platform,
      arch: info.arch,
    });
    const archive = join(staging, info.asset_name);
    await downloadFile(info.download_url, archive);

    // 解压到临时目录（zip 用 unzip，tar.gz 用 tar）
    const extractDir = join(staging, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    const isZip = info.asset_name.endsWith('.zip');
    const extract = isZip
      ? await runProcess('unzip', ['-q', '-o', archive, '-d', extractDir])
      : await runProcess('tar', ['-xzf', archive, '-C', extractDir]);
    if (extract.code !== 0) {
      throw new Error(`解压失败：${extract.output.slice(-400)}`);
    }

    // 压缩包固定顶层 gh_<ver>_<os>_<arch>/bin/<gh|gh.exe>，直接定位，无需深递归
    const sourceBin = findGhBinary(extractDir);
    if (!sourceBin) throw new Error('解压内容中未找到 gh 可执行文件');

    // 只把 bin 可执行文件复制到安装目录并赋予执行权限
    mkdirSync(info.install_dir, { recursive: true });
    const target = info.bin_path;
    writeFileSync(target, readFileSync(sourceBin));
    if (process.platform !== 'win32') {
      await runProcess('chmod', ['+x', target]);
    }
    logger.info('market', 'GitHub CLI 安装完成', {
      version: info.version,
      bin_path: target,
      in_path: info.in_path,
    });
    return info;
  } catch (e) {
    throw new MarketError(`安装 GitHub CLI 失败：${(e as Error).message}`, 'GH_INSTALL_FAILED');
  } finally {
    // 无论成败都清理临时目录，避免残留安装包/解压产物
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 在解压目录中定位 gh 可执行文件（zip/tar 顶层为 gh_<ver>_<os>_<arch>/bin/<gh>） */
function findGhBinary(dir: string): string | null {
  const binName = ghBinName();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (existsSync(full) && statSync(full).isDirectory()) {
      const found = findGhBinary(full);
      if (found) return found;
    } else if (entry === binName) {
      return full;
    }
  }
  return null;
}

// ===== GitHub 登录（后台驱动 gh auth login，前端展示 one-time code + URL） =====

export interface GhLoginInfo {
  /** 一次性验证码（用户在浏览器输入） */
  code: string;
  /** 浏览器授权地址 */
  url: string;
  /** 登录是否仍在此后端等待授权完成（进程存活中） */
  pending: boolean;
}

/**
 * 登录用 gh 子进程句柄（保存以便取消；同一时刻仅一个登录进程）。
 * gh 完成授权后自行退出并写入凭据，无需后端轮询。
 */
let activeLogin: ReturnType<typeof spawn> | null = null;

/**
 * 后台启动 GitHub 登录（device flow）：
 * 运行 `gh auth login -p https --skip-ssh-key`，通过 stdin 预喂两次回车应答交互
 * （默认：对 git 使用 GitHub 凭据=Yes；认证方式选默认的「Login with a web browser」），
 * gh 随即向 GitHub 发起 device code 请求并打印 one-time code + 授权 URL。
 *
 * 注意：必须注入系统代理（gh 是 Go 程序，默认不读 macOS 系统代理）且**不能设
 * GH_PROMPT_DISABLED=1**（否则 gh 静默等待、不打印验证码）。
 * gh 子进程保持运行并自行完成授权轮询，授权成功后写入凭据并退出。
 */
export async function startGhLogin(): Promise<GhLoginInfo> {
  // 已登录则直接返回（幂等）
  const status = await getMarketStatus();
  if (status.gh_authed) {
    throw new MarketError('GitHub 已登录，无需重复登录', 'GH_ALREADY_AUTHED');
  }
  // 已有进行中的登录进程：返回 pending 占位，避免重复启动
  if (activeLogin && activeLogin.exitCode === null) {
    return { code: '', url: '', pending: true };
  }
  activeLogin = null;

  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  const proxy = detectHttpsProxy();
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
  }
  const loginEnv = { ...process.env, ...env };

  return new Promise((resolve, reject) => {
    const child = spawn(
      ghBinPath(),
      ['auth', 'login', '-p', 'https', '--hostname', 'github.com', '--skip-ssh-key'],
      { env: loginEnv, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '';
    let settled = false;
    const finish = (info: GhLoginInfo) => {
      if (settled) return;
      settled = true;
      resolve(info);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new MarketError(message, 'GH_LOGIN_FAILED'));
    };

    // 应答两个交互问题：先 Yes（Authenticate Git?），再回车选默认的浏览器登录
    child.stdin.write('\n\n');

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      parseGhCode(output, finish);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      parseGhCode(output, finish);
    });
    child.on('error', (error) => {
      fail(`启动 gh 登录失败：${error.message}`);
    });
    child.on('close', (code) => {
      if (activeLogin === child) activeLogin = null;
      if (!settled) {
        fail(`gh 登录进程退出（code ${code ?? '?'}）：${output.slice(-300)}`);
      }
    });

    activeLogin = child;
    // 30s 内未打印验证码视为失败（网络/交互异常），及时回收进程避免悬挂
    const guard = setTimeout(() => {
      if (!settled) {
        child.kill('SIGKILL');
        fail('gh 登录超时：未能获取一次性验证码，请检查网络后重试');
      }
    }, 30_000);
    guard.unref();
    child.once('close', () => clearTimeout(guard));
  });
}

/** 从 gh 输出中解析 one-time code 与授权 URL；解析到则 resolve */
function parseGhCode(output: string, finish: (info: GhLoginInfo) => void): void {
  const code = output.match(/one-time code:\s*([A-Z0-9-]{4,})/i)?.[1];
  const url = output.match(/https:\/\/github\.com\/login\/device/i)?.[0];
  if (code && url) {
    finish({ code, url, pending: true });
  }
}

/** 取消进行中的 gh 登录进程（前端放弃登录时调用） */
export function cancelGhLogin(): void {
  if (activeLogin && activeLogin.exitCode === null) {
    activeLogin.kill('SIGKILL');
  }
  activeLogin = null;
}


