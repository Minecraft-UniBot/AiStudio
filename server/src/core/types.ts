/**
 * Extension Studio 共享类型定义。
 *
 * 对应 Plan.md 第四章「状态模型」与第六章「后端 API 草案」。
 */

/**
 * MC 服务器上的插件/模组条目（从 jar 内清单提取的元数据）。
 * 解析失败时仅保留文件名，meta 为空。
 */
export interface McPackageEntry {
  /** 显示名（plugin.yml name / fabric.mod.json name / mods.toml displayName / 文件名兜底） */
  name: string;
  /** jar 文件名（含扩展名） */
  file: string;
  /** 清单声明的版本（缺失为 null） */
  version: string | null;
  /** 依赖的插件/模组 id 列表（Bukkit depend/softdepend、Fabric depends 等，可为空） */
  depends?: string[];
}

/**
 * MC 服务器扫描结果（服务端类型 + 版本 + 插件/模组清单）。
 * 创建草稿时整体快照进 DraftMeta.mc_server，保证规划/编码提示词可复现。
 */
export interface McServerInfo {
  /** 服务器根目录（绝对路径） */
  dir: string;
  /** 服务端类型：paper / purpur / folia / spigot / craftbukkit / fabric / forge / neoforge / quilt / vanilla / unknown */
  type: string;
  /** 类型展示名（如「Paper」「NeoForge」） */
  label: string;
  /** Minecraft 游戏版本（如 1.21.4；无法识别为 null） */
  mc_version: string | null;
  /** 加载器/核心版本（Fabric Loader / Forge / NeoForge / 核心端构建号；无法识别为 null） */
  loader_version: string | null;
  /** Bukkit 系插件（plugins/*.jar）；非 Bukkit 端为空数组 */
  plugins: McPackageEntry[];
  /** 模组（mods/*.jar + libraries 探测到的加载器信息不在此列）；非模组端为空数组 */
  mods: McPackageEntry[];
  scanned_at: string;
}

/** 草稿主状态机（规划 → 编码 → 机械校验 → 发布；编码阶段 AI 用测试工具自测） */
export type DraftStatus =
  | 'draft'       // 已创建，未开始
  | 'planning'    // 规划中（AI 先询问需求，输出规划）
  | 'coding'      // 编码中（自动加载对应 skill，实现代码并用测试工具自测）
  | 'ready'       // 机械校验通过，可发布
  | 'published'   // 已发布（只读）
  | 'error';      // 会话丢失等可恢复错误

/** 流水线阶段（与草稿主状态机正交：status 可被 abort/聊天等交互置回 draft，phase 保留用于续接流转） */
export type PipelinePhase = 'planning' | 'coding';

/** 扩展类型（第一版仅 api / command） */
export type ExtensionType = 'api' | 'command' | 'renderer' | 'template' | 'resources';

/** 模型选择 */
export interface ModelChoice {
  provider_id: string;
  model_id: string;
  label?: string;
}

/** 校验步骤 */
export type ValidationStepId =
  | 'paths'          // 路径、符号链接、文件数和大小检查
  | 'manifest'       // Extension.toml 严格 schema 校验
  | 'syntax'         // Python 语法与 import 边界
  | 'ruff'           // Ruff format + lint
  | 'tests'          // 草稿自带测试
  | 'loader'         // 真实 Loader 发现、绑定
  | 'dependencies'   // 依赖声明检查
  | 'env'            // 测试环境未就绪（非代码问题，AI 无法修复）
  | 'interrupted';   // 校验因服务重启/进程退出中断（非代码问题，重新校验即可）

export interface ValidationStepResult {
  id: ValidationStepId;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  message?: string;
  detail?: string;
  duration_ms: number;
  started_at?: string;
  finished_at?: string;
}

export interface ValidationRun {
  id: string;
  status: 'running' | 'passed' | 'failed';
  steps: ValidationStepResult[];
  started_at: string;
  finished_at?: string;
  /** 本次校验对应的文件摘要（发布前必须核对） */
  revision: string;
}

/** 草稿元数据（draft.json） */
export interface DraftMeta {
  schema_version: 1;
  id: string;
  extension_id: string;
  name: string;
  description: string;
  types: ExtensionType[];
  /** 创建时所选的开发模板（minimal / Default 等）；用于可重复性与展示 */
  template_id?: string | null;
  /**
   * 创建时选择的目标 MC 服务器快照（类型/版本/插件模组清单）。
   * 注入规划与编码提示词，供 AI 结合真实服务器环境做技术选型；
   * 未选择服务器时为 null。
   */
  mc_server?: McServerInfo | null;
  owner_id: string;
  status: DraftStatus;
  /**
   * 当前流水线阶段。与 status 不同：abort / 聊天消息会把 status 置为 draft，
   * 但 phase 保留，用户重新发消息时按 phase 恢复 status，保证
   * 规划→编码→审查的自动流转在「中止后继续」场景下仍然生效。
   */
  phase?: PipelinePhase | null;
  session_id: string | null;
  model: ModelChoice | null;
  /** 开发途中的一次性模型切换是否已用掉（每个草稿仅允许切换一次，见 POST /drafts/:id/model） */
  model_switched?: boolean;
  agent: string;
  /** 规划产物（PLAN.md 内容摘要，供前端展示） */
  plan_summary?: string | null;
  /** 机械校验结果 */
  validation: ValidationRun | null;
  /** 最近一次通过检查的文件摘要（SHA-256），发布前必须核对 */
  validation_revision: string | null;
  /**
   * 最近一次回退的目标消息 ID（OpenCode revert 是「暂存式」：文件立即恢复，
   * 对话消息要等下一次 prompt 才物理删除）。消息列表按此 ID 过滤，
   * 让前端立即呈现回退后的对话；发送新消息时清除。
   */
  revert_message_id?: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  error?: string;
}

/** 权限回复（对应 OpenCode permission.replied） */
export type PermissionDecision = 'once' | 'always' | 'reject';

/** 会话重试细节（opencode SessionStatus.retry：模型流式失败后的自动退避重试） */
export interface SessionRetryDetail {
  /** 第几次尝试（从 1 起） */
  attempt: number;
  /** 失败原因（如 AI_APICallError: Upstream request failed） */
  message: string;
  /** 下次重试时间（epoch 毫秒；0 表示未知） */
  next: number;
}

/** 事件载荷（后端归一化后推送给前端） */
export type StudioEvent =
  | { type: 'session.status'; draft_id: string; status: string; retry?: SessionRetryDetail }
  | { type: 'session.idle'; draft_id: string }
  | { type: 'session.error'; draft_id: string; error: string }
  | { type: 'message.updated'; draft_id: string; message: unknown }
  | { type: 'message.part.updated'; draft_id: string; message_id: string; part: unknown }
  | { type: 'session.diff'; draft_id: string }
  | { type: 'todo.updated'; draft_id: string; todo: unknown }
  | { type: 'permission.asked'; draft_id: string; permission: PermissionRequest }
  | { type: 'permission.replied'; draft_id: string; permission_id: string }
  | { type: 'permission.auto_granted'; draft_id: string; permission: PermissionRequest }
  | { type: 'question.asked'; draft_id: string; question: QuestionRequest }
  | { type: 'question.replied'; draft_id: string; question_id: string }
  | { type: 'question.rejected'; draft_id: string; question_id: string }
  | { type: 'draft.updated'; draft_id: string; status: DraftStatus }
  | { type: 'validation.updated'; draft_id: string; run: ValidationRun }
  | { type: 'unibot-env.updated'; status: UnibotEnvStatus }
  | { type: 'draft.published'; draft_id: string };

/** OpenCode permission 请求（归一化后的最小字段） */
export interface PermissionRequest {
  id: string;
  session_id: string;
  permission: string;
  tool_name: string;
  description: string;
  metadata: Record<string, unknown>;
}

/** OpenCode question 选项（对应 QuestionV1.Option：{ label, description }） */
export interface QuestionOption {
  label: string;
  description: string;
}

/** OpenCode question 单条提问（对应 QuestionV1.Info） */
export interface QuestionItem {
  header: string;
  question: string;
  options: QuestionOption[];
  multiple: boolean;
  /** 是否允许输入自定义答案（默认 true） */
  custom: boolean;
}

/**
 * OpenCode question 请求（对应 QuestionV1.Request，事件 question.asked 的 properties）。
 * 一次请求可包含多条提问；回答必须经 `POST /question/:id/reply` 以
 * `{ answers: string[][] }` 回传（每个问题一个数组），模型才会继续执行。
 */
export interface QuestionRequest {
  id: string;
  session_id: string;
  questions: QuestionItem[];
  /** question 工具调用位置（工具恢复后用于刷新对应 part） */
  tool?: { messageID: string; callID: string };
}

/** 发布记录 */
export interface PublishRecord {
  draft_id: string;
  extension_id: string;
  target_dir: string;
  revision: string;
  prompt_versions: Record<string, string>;
  published_at: string;
}

/** 工具注册表条目（对应 Plan.md 7.2） */
export interface ToolEntry {
  id: string;
  enabled: boolean;
  default_permission: 'allow' | 'ask' | 'reject';
  phases: Array<'generate'>;
  note?: string;
}

/** UniBot 测试环境状态（共享一份，供校验流水线使用） */
export interface UnibotEnvStatus {
  /** missing：未就绪；downloading：下载中；installing：解压/装依赖中；ready：可用；error：失败 */
  state: 'missing' | 'downloading' | 'installing' | 'ready' | 'error';
  /** 测试环境根目录（<data_dir>/unibot） */
  path: string;
  /** 源码版本（pyproject.toml 的 [project].version） */
  version: string | null;
  /** 来源 GitHub release tag */
  tag: string | null;
  /** venv 是否就绪（.venv/bin/python 存在） */
  venv_ready: boolean;
  error: string | null;
  updated_at: string | null;
}

/** 平台配置（config/studio.json） */
export interface StudioConfig {
  data_dir: string;
  /** UniBot 根目录（发布目标 Extensions/ 的父目录） */
  unibot_dir: string;
  /** 是否已由用户显式配置 UniBot 目录（false = 启动时自动探测，需在首次登录时引导确认） */
  unibot_configured: boolean;
  /** UniBot 扩展发布目录（unibot_dir/Extensions） */
  extensions_dir: string;
  /** 目标 MC 服务器目录（可选；创建草稿时扫描并快照进草稿元数据） */
  mc_server_dir?: string;
  host: string;
  port: number;
  /** 前端静态资源目录（单文件可执行版：由 release/src/main.ts 解压内置 web/dist 后经 UNIBOT_STUDIO_STATIC_DIR 注入；为空则不提供静态服务） */
  static_dir: string;
  opencode: {
    bin: string;
    version: string;
    data_dir: string;
    /** LLM 整次请求超时（毫秒），注入 provider.options.timeout */
    timeout_ms: number;
    /** LLM 流式块间隔超时（毫秒），注入 provider.options.chunkTimeout */
    chunk_timeout_ms: number;
  };
  /** UniBot 测试环境：GitHub Releases 来源与本地目录 */
  unibot_env: {
    /** release 仓库 owner（如 MineJPGcraft） */
    repo_owner: string;
    /** release 仓库名（如 UniBot） */
    repo_name: string;
    /** 发布资产文件名（如 UniBot.zip） */
    release_asset: string;
    /** 无法访问 GitHub API 时回退的固定 tag（如 v1.0.1） */
    fallback_tag: string;
    /** 测试环境目录（共享一份，不随草稿复制） */
    test_dir: string;
  };
  features: {
    test_tools: boolean;
    mc_test_environment: boolean;
    market_publish: boolean;
    git_integration: boolean;
  };
  defaults: {
    agent: string;
  };
  auth: {
    /** 平台访问口令（首次启动自动生成，可被环境变量 UNIBOT_STUDIO_PASSWORD 覆盖） */
    password: string;
    /** token 签名密钥（首次启动自动生成并持久化，重启后已签发 token 仍有效） */
    token_secret: string;
  };
}

/** UniBot 校验脚本返回的结构化结果 */
export interface UnibotValidationOutput {
  ok: boolean;
  steps: Array<{
    id: string;
    name: string;
    ok: boolean;
    message?: string;
    detail?: string;
  }>;
  extension_id?: string;
  manifest?: Record<string, unknown>;
}
