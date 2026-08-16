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

/**
 * 编排检查点识别：编排系统（后端流水线）会以 promptAsync 把各阶段的提示词
 * （规划 / 编码 / 调试 / 审查）注入会话，表现为 role=user 的长文本消息。
 * 这些提示词统一经 renderPromptWithSecurity 追加「后端安全约束」尾部，
 * 特征稳定，据此识别并折叠为「进入…阶段」的分割线检查点。
 * 返回 { stage, label }；非检查点消息返回 null。
 */
export function checkpoint_of(message) {
  if (!message || message?.info?.role !== 'user') return null
  const text = (message.parts ?? [])
    .filter((p) => p?.type === 'text')
    .map((p) => String(p.text ?? ''))
    .join('\n')
  if (!text.includes('后端安全约束')) return null
  // 阶段识别：按各阶段提示词正文特征（模板可编辑，用宽松关键词兜底）
  if (/第二阶段|实现编码/.test(text)) return { stage: 'coding', label: '进入编码阶段' }
  if (/修复工程师|问题单/.test(text)) return { stage: 'debugging', label: '进入修复阶段' }
  if (/审查员|第三阶段|只读审查/.test(text)) return { stage: 'reviewing', label: '进入审查阶段' }
  if (/第一阶段|需求规划/.test(text)) return { stage: 'planning', label: '进入规划阶段' }
  return { stage: '', label: '编排检查点' }
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

/** 从 ToolState.time 提取起止时间戳（ms）；无数据返回 null */
function state_time(state) {
  const time = state?.time
  if (!time || typeof time.start !== 'number') return null
  return { start: time.start, end: typeof time.end === 'number' ? time.end : null }
}

/** 归一化工具调用 part → 稳定的扁平视图模型 */
export function normalize_tool(part) {
  const state = part.state ?? {}
  const input = state.input ?? {}
  const { start, end } = state_time(state) ?? {}
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
    start,
    end,
  }
  // todowrite：把 input.todos 结构化为待办清单视图模型
  if (base.name === 'todowrite' && Array.isArray(input.todos)) {
    base.todos = input.todos.map((t) => ({
      content: String(t?.content ?? ''),
      status: String(t?.status ?? 'pending'),
      priority: String(t?.priority ?? 'medium'),
    }))
  }
  // question：AI 提问工具（向用户确认），结构化为问题卡片。
  // 工具完成后 opencode 会把用户回答回填到 state.metadata.answers（每题一个数组），
  // 前端据此直接展示回答，不再显示选项列表。
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
    const answers = state.metadata?.answers
    if (Array.isArray(answers)) {
      base.answers = answers.map((a) => (Array.isArray(a) ? a.map(String) : [String(a ?? '')]))
    }
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

/** 耗时格式化：<1s 毫秒，<1min 秒，更久分+秒 */
export function format_duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

/** 工具自身执行耗时（start → end）；兼容归一化前后两种结构 */
export function tool_duration(part) {
  const start = part?.start ?? part?.state?.time?.start
  const end = part?.end ?? part?.state?.time?.end
  if (typeof start !== 'number' || typeof end !== 'number') return ''
  return format_duration(end - start)
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
