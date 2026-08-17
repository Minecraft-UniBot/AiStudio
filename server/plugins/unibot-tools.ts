/**
 * UniBot 测试工具插件（Extension Studio 专属，对应 AGENT.md 3.5）。
 *
 * 作用：让生成会话内的 AI 在编码过程中直接对「共享 UniBot 测试环境」做
 * 部署 → 加载 → 验证 → 观察日志 的闭环测试，发现异常当场修复重试。
 *
 * 实现约定：
 * - 插件运行在 opencode 进程内，但**不做任何文件/子进程操作**——每个工具
 *   只组装参数并回调 Studio REST API（`UNIBOT_STUDIO_API_URL`），所有
 *   文件操作、路径校验与子进程执行都由后端完成（保持「后端是唯一可信边界」）。
 * - 认证：Studio 启动 opencode 子进程时注入 `UNIBOT_STUDIO_API_TOKEN`
 *   （HMAC 签名 token），插件以 `Authorization: Bearer <token>` 调用。
 * - 本文件由 Studio 后端在 opencode 启动前用 Bun.build 打包为自包含 JS
 *   （内联 @opencode-ai/plugin 与 zod），写入隔离配置目录的 plugins/ 目录，
 *   因此不依赖运行时 node_modules。
 */
import { type Plugin, tool } from "@opencode-ai/plugin"

const apiBase = process.env.UNIBOT_STUDIO_API_URL ?? ""
const apiToken = process.env.UNIBOT_STUDIO_API_TOKEN ?? ""

/** 调用 Studio API（{ code, data, message } 包装，非 0 抛错） */
async function call(path: string, body?: unknown): Promise<unknown> {
  if (!apiBase) throw new Error("UNIBOT_STUDIO_API_URL 未配置：测试工具不可用")
  if (!apiToken) throw new Error("UNIBOT_STUDIO_API_TOKEN 未配置：测试工具不可用")
  const res = await fetch(`${apiBase}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json()) as { code?: number; data?: unknown; message?: string }
  if (json.code !== 0) throw new Error(json.message ?? `Studio API ${res.status}`)
  return json.data
}

/** 统一输出：结构化的 JSON 文本，便于 AI 阅读与后续工具复用 */
function pretty(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

export const UnibotToolsPlugin: Plugin = async (ctx) => ({
  tool: {
    unibot_test_status: tool({
      description:
        "查询 UniBot 测试环境状态（源码版本、venv 是否就绪、已部署的扩展列表）。" +
        "在部署/加载/运行测试之前先调用它确认环境就绪。",
      args: {},
      async execute(_args, context) {
        return pretty(
          await call(`/api/studio/test/env`, { workspace: context.directory }),
        )
      },
    }),
    unibot_test_sync: tool({
      description:
        "触发 UniBot 测试环境同步（后台拉取最新源码 + uv 安装依赖，可能耗时数分钟）。" +
        "环境未就绪或版本过旧时调用；同步是异步的，随后用 unibot_test_status 确认就绪。",
      args: {},
      async execute(_args, context) {
        return pretty(
          await call(`/api/studio/test/sync`, { workspace: context.directory }),
        )
      },
    }),
    unibot_deploy: tool({
      description:
        "把当前草稿扩展部署（复制）到共享 UniBot 测试环境的 Extensions/<extension_id>/，" +
        "使用 staging + 原子重命名，可覆盖已部署的同名扩展。只影响测试环境，不触碰正式扩展目录。",
      args: {
        extension_id: tool.schema
          .string()
          .describe("扩展 ID（PascalCase，与草稿目录名一致）"),
      },
      async execute(args, context) {
        return pretty(
          await call(`/api/studio/test/deploy`, {
            workspace: context.directory,
            extension_id: args.extension_id,
          }),
        )
      },
    }),
    unibot_undeploy: tool({
      description: "从 UniBot 测试环境的 Extensions/ 移除指定扩展（清理测试现场）。",
      args: {
        extension_id: tool.schema
          .string()
          .describe("扩展 ID（PascalCase，与草稿目录名一致）"),
      },
      async execute(args, context) {
        return pretty(
          await call(`/api/studio/test/undeploy`, {
            workspace: context.directory,
            extension_id: args.extension_id,
          }),
        )
      },
    }),
    unibot_load: tool({
      description:
        "在 UniBot 测试环境中加载指定扩展并报告绑定结果（Loader 发现、入口导入、" +
        "extension.id 与目录名一致性）。加载失败会给出诊断信息，供 AI 修复后重试。",
      args: {
        extension_id: tool.schema
          .string()
          .describe("扩展 ID（PascalCase，与草稿目录名一致）"),
      },
      async execute(args, context) {
        return pretty(
          await call(`/api/studio/test/load`, {
            workspace: context.directory,
            extension_id: args.extension_id,
          }),
        )
      },
    }),
    unibot_logs: tool({
      description:
        "读取该扩展在测试环境中的最近测试/加载日志（后端按扩展 ID 维护的测试日志文件尾部）。",
      args: {
        extension_id: tool.schema
          .string()
          .describe("扩展 ID（PascalCase，与草稿目录名一致）"),
        lines: tool.schema
          .number()
          .optional()
          .describe("返回的最大行数（默认 50）"),
      },
      async execute(args, context) {
        return pretty(
          await call(`/api/studio/test/logs`, {
            workspace: context.directory,
            extension_id: args.extension_id,
            lines: args.lines,
          }),
        )
      },
    }),
    unibot_run_tests: tool({
      description:
        "在 UniBot 测试环境运行已部署扩展自带的 pytest 测试（tests/ 目录），返回结构化结果。" +
        "测试失败时根据输出修复草稿，然后重新部署并再次运行。",
      args: {
        extension_id: tool.schema
          .string()
          .describe("扩展 ID（PascalCase，与草稿目录名一致）"),
      },
      async execute(args, context) {
        return pretty(
          await call(`/api/studio/test/run-tests`, {
            workspace: context.directory,
            extension_id: args.extension_id,
          }),
        )
      },
    }),
    unibot_validate: tool({
      description:
        "对草稿运行与发布前一致的完整机械校验流水线（只读：路径、清单、语法、" +
        "Ruff、测试、Loader 绑定、依赖声明）。不修改任何文件，仅报告结果。",
      args: {
        extension_id: tool.schema
          .string()
          .describe("扩展 ID（PascalCase，与草稿目录名一致）"),
      },
      async execute(args, context) {
        return pretty(
          await call(`/api/studio/test/validate`, {
            workspace: context.directory,
            extension_id: args.extension_id,
          }),
        )
      },
    }),
  },
})
