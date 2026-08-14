/**
 * OpenCode parts 归一化（对应 Plan.md 九「前端模块规划」utils/opencode_parts.js）
 *
 * 把 OpenCode SDK 返回的原始 message.parts 转成稳定的前端视图模型，
 * 避免业务组件直接依赖上游字段结构。
 *
 * 真实 ToolPart 结构（@opencode-ai/sdk types.gen.d.ts）：
 *   { type: 'tool', tool, callID, state: { status, input, title, output?, error? } }
 * 状态：pending | running | completed | error
 */

/** 归一化一条消息的全部 parts */
export function normalize_parts(message) {
  const parts = message?.parts ?? []
  return parts.map(normalize_part).filter(Boolean)
}

/** 归一化单个 part；无法识别的类型返回 null */
export function normalize_part(part) {
  if (!part || typeof part !== 'object') return null
  switch (part.type) {
    case 'text':
      return { type: 'text', text: String(part.text ?? '') }
    case 'reasoning':
      return { type: 'reasoning', text: String(part.text ?? '') }
    case 'tool':
      return normalize_tool(part)
    case 'step-start':
      return { type: 'step-start' }
    case 'step-finish':
      return { type: 'step-finish', reason: String(part.reason ?? '') }
    case 'subtask':
      return { type: 'subtask', agent: String(part.agent ?? ''), prompt: String(part.prompt ?? '') }
    case 'retry':
      return { type: 'retry', reason: String(part.reason ?? '') }
    case 'file':
      return { type: 'file', filename: String(part.filename ?? part.url ?? '') }
    default:
      return null
  }
}

/** 归一化工具调用 part → 稳定的扁平视图模型 */
export function normalize_tool(part) {
  const state = part.state ?? {}
  const input = state.input ?? {}
  const base = {
    type: 'tool',
    id: String(part.id ?? part.callID ?? ''),
    name: String(part.tool ?? ''),
    status: String(state.status ?? 'pending'),
    title: String(state.title ?? ''),
    input,
    label: tool_label(part),
    output: stringify(state.output),
    error: stringify(state.error),
  }
  // todowrite：把 input.todos 结构化为待办清单视图模型
  if (base.name === 'todowrite' && Array.isArray(input.todos)) {
    base.todos = input.todos.map((t) => ({
      content: String(t?.content ?? ''),
      status: String(t?.status ?? 'pending'),
      priority: String(t?.priority ?? 'medium'),
    }))
  }
  // question：AI 提问工具（向用户确认），结构化为问题卡片
  if (base.name === 'question' && Array.isArray(input.questions)) {
    base.questions = input.questions.map((q) => ({
      header: String(q?.header ?? ''),
      question: String(q?.question ?? ''),
      options: Array.isArray(q?.options)
        ? q.options.map((o) => ({
            label: String(o?.label ?? ''),
            description: String(o?.description ?? ''),
          }))
        : [],
    }))
  }
  // read：从 output 的 XML 包装 <content>…</content> 中提取文件内容（去掉路径/类型标签）
  if (base.name === 'read') {
    const m = String(base.output ?? '').match(/<content>([\s\S]*?)<\/content>/)
    if (m && m[1].trim()) base.file_content = m[1].trim()
  }
  return base
}

/** 从 tool state 提取展示状态：ok / fail / wait / run（兼容归一化前后两种结构） */
export function tool_status(part) {
  const status = part?.status ?? part?.state?.status ?? 'pending'
  if (status === 'completed') return 'ok'
  if (status === 'error') return 'fail'
  if (status === 'pending') return 'wait'
  return 'run'
}

/** 工具展示名：read file.py / bash rm -rf / web_search query */
export function tool_label(part) {
  const name = part?.name ?? part?.tool ?? ''
  const input = part?.input ?? part?.state?.input ?? {}
  if (name === 'todowrite') return '更新任务清单'
  if (name === 'question') return '向你提问'
  if (name === 'read' || name === 'edit') {
    const file = filePathOf(input)
    if (file) return `${name} ${basename(file)}`
  }
  if (typeof input !== 'object' || input === null) {
    return name || '工具'
  }
  const file = filePathOf(input)
  if (file) return `${name} ${basename(file)}`
  const cmd = input.command
  if (cmd) return `${name} ${cmd}`
  const query = input.query
  if (query) return `${name} ${query}`
  // 兜底：取第一个字符串参数，避免整段 JSON 刷屏
  const first = Object.values(input).find((v) => typeof v === 'string')
  if (first) return `${name} ${first.slice(0, 60)}`
  return name || '工具'
}

/** 兼容 read/edit 工具的路径字段命名：file_path / path / filePath */
function filePathOf(input) {
  return input?.file_path ?? input?.path ?? input?.filePath
}

/** 取路径最后一段（read/edit 的标签避免长路径刷屏） */
function basename(path) {
  const cleaned = String(path).replace(/\/+$/, '')
  const seg = cleaned.split('/').pop()
  return seg || cleaned
}

/** 工具执行结果正文（completed → output，error → error；兼容归一化前后两种结构） */
export function tool_result(part) {
  // read：从 output 的 XML 包装 <content>…</content> 中提取文件内容（去掉路径/类型标签）
  if (part?.name === 'read' && typeof part?.output === 'string') {
    const m = part.output.match(/<content>([\s\S]*?)<\/content>/)
    if (m && m[1].trim()) return m[1].trim()
  }
  // read/edit：优先展示 input.content（文件内容预览，比原始 output 更可读）
  if (part?.file_content) return part.file_content
  const raw_input = part?.input ?? part?.state?.input
  if (raw_input && typeof raw_input === 'object' && typeof raw_input.content === 'string') {
    if (raw_input.content.trim()) return raw_input.content
  }
  const state = part?.state
  if (state) {
    if (state.status === 'error') return stringify(state.error)
    return stringify(state.output)
  }
  // 归一化后的扁平结构
  if (part?.status === 'error') return stringify(part.error)
  return stringify(part?.output)
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}
