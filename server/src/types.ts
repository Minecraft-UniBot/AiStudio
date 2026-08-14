/**
 * Extension Studio 共享类型定义。
 *
 * 对应 Plan.md 第四章「状态模型」与第六章「后端 API 草案」。
 */

/** 草稿主状态机（三阶段：规划 → 编码 → 审查） */
export type DraftStatus =
  | 'draft'       // 已创建，未开始
  | 'planning'    // 规划中（AI 先询问需求，输出规划）
  | 'coding'      // 编码中（自动加载对应 skill，实现代码）
  | 'reviewing'   // 审查中（独立审核 AI 只读审查）
  | 'debugging'   // 修复中（审查发现问题后的自动修复）
  | 'ready'       // 审查通过，可发布
  | 'published'   // 已发布（只读）
  | 'failed'      // 连续无进展 / 超出轮次
  | 'error';      // 会话丢失等可恢复错误

/** 扩展类型（第一版仅 api / command） */
export type ExtensionType = 'api' | 'command' | 'renderer' | 'template' | 'resources';

/** 模型选择 */
export interface ModelChoice {
  provider_id: string;
  model_id: string;
  label?: string;
}

/** AI 审核问题 */
export type IssueSeverity = 'must_fix' | 'suggestion' | 'passed';

export interface ReviewIssue {
  id: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  file?: string;
  suggestion?: string;
  /** 修复后由调试阶段回填验证结果 */
  verified?: boolean;
}

/** 调试轮次记录（持久化，用于无进展熔断） */
export interface ReviewRound {
  round: number;
  /** 调试开始前的文件摘要 */
  revision_before: string;
  /** 调试结束后的文件摘要（settle 时回填） */
  revision_after?: string;
  must_fix_count: number;
}

/** 审核结果 */
export interface ReviewResult {
  round: number;
  max_rounds: number;
  status: 'passed' | 'needs_confirmation' | 'failed';
  issues: ReviewIssue[];
  summary: string;
  /** 调试轮次历史（每次 startDebugging 追加一条） */
  rounds: ReviewRound[];
  updated_at: string;
}

/** 校验步骤 */
export type ValidationStepId =
  | 'paths'          // 路径、符号链接、文件数和大小检查
  | 'manifest'       // Extension.toml 严格 schema 校验
  | 'syntax'         // Python 语法与 import 边界
  | 'ruff'           // Ruff format + lint
  | 'tests'          // 草稿自带测试
  | 'loader'         // 真实 Loader 发现、绑定
  | 'dependencies';  // 依赖声明检查

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
  owner_id: string;
  status: DraftStatus;
  session_id: string | null;
  review_session_id: string | null;
  model: ModelChoice | null;
  agent: string;
  review: ReviewResult | null;
  /** 最近一次审查通过时的文件摘要（SHA-256），发布前必须核对 */
  review_revision: string | null;
  /** 规划产物（PLAN.md 内容摘要，供前端展示） */
  plan_summary?: string | null;
  /** 兼容旧版草稿：校验结果（新流程不再生成） */
  validation: ValidationRun | null;
  /** 最近一次通过检查的文件摘要（SHA-256），兼容旧版 */
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

/** 事件载荷（后端归一化后推送给前端） */
export type StudioEvent =
  | { type: 'session.status'; draft_id: string; status: string }
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
  | { type: 'review.updated'; draft_id: string; review: ReviewResult }
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
  phases: Array<'generate' | 'review' | 'debug'>;
  note?: string;
}

/** 平台配置（config/studio.json） */
export interface StudioConfig {
  data_dir: string;
  unibot_dir: string;
  extensions_dir: string;
  host: string;
  port: number;
  opencode: {
    bin: string;
    version: string;
    data_dir: string;
  };
  features: {
    review: boolean;
    mc_test_environment: boolean;
    market_publish: boolean;
    git_integration: boolean;
  };
  defaults: {
    agent: string;
    max_review_rounds: number;
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
