<script setup>
// 消息部件渲染：文本 / 推理 / 工具调用 / 步骤 / 错误
// parts 统一经 utils/opencode_parts.js 归一化，不直接依赖 OpenCode 原始字段
import { computed, ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { normalize_parts, tool_status, tool_label, tool_result, format_duration } from '@/utils/opencode_parts'
import { render_markdown } from '@/utils/markdown'

const props = defineProps({
  message: { type: Object, required: true },
})

const emit = defineEmits(['revert'])

const isUser = computed(() => props.message.info?.role === 'user')
const messageId = computed(() => props.message.info?.id ?? '')
const parts = computed(() => normalize_parts(props.message))
const summary = computed(() => props.message.info?.summary?.body ?? '')

/** 用户手动展开的工具调用（按 part.id 或下标），完成/失败默认收起，点击头部切换 */
const expanded_tools = ref(new Set())

// 工具从「执行中」变为「完成/失败」时自动收起；首次渲染已完成工具一律收起
watch(
  parts,
  (list, prev) => {
    if (!prev) return
    const prev_map = new Map(prev.map((p, i) => [p.id || i, p]))
    const next = new Set(expanded_tools.value)
    list.forEach((part, idx) => {
      if (part.type !== 'tool') return
      const key = part.id || idx
      const before = prev_map.get(key)
      if (before && tool_status(before) === 'run' && tool_status(part) !== 'run') {
        next.delete(key)
      }
    })
    expanded_tools.value = next
  },
  { immediate: true },
)

function tool_key(part, idx) {
  return part.id || idx
}

/** 执行中强制展开；其余看用户是否点击展开 */
function tool_open(part, idx) {
  if (tool_status(part) === 'run') return true
  return expanded_tools.value.has(tool_key(part, idx))
}

/** read / write / webfetch 工具调用不展示内容预览（文件/网页内容占屏且无必要） */
function compact_tool(part) {
  return part.name === 'read' || part.name === 'write' || part.name === 'webfetch'
}

function toggle_tool(part, idx) {
  const key = tool_key(part, idx)
  const next = new Set(expanded_tools.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded_tools.value = next
}

/** 本条消息总耗时（消息完成 − AI 开始输出，ms）；消息未完成或无数据返回空 */
const msg_elapsed = computed(() => {
  const t = props.message.info?.time
  if (!t || typeof t.created !== 'number' || typeof t.completed !== 'number') return ''
  return format_duration(t.completed - t.created)
})

/** markdown 渲染（仅 AI 内容使用；用户消息保持纯文本） */
function md_text(text) {
  return render_markdown(text)
}

function partIcon(type) {
  switch (type) {
    case 'reasoning':
      return 'lucide:brain'
    case 'tool':
      return 'lucide:wrench'
    case 'step-start':
      return 'lucide:play'
    case 'step-finish':
      return 'lucide:check-circle-2'
    case 'subtask':
      return 'lucide:git-branch'
    case 'retry':
      return 'lucide:rotate-ccw'
    case 'file':
      return 'lucide:file'
    default:
      return 'lucide:circle'
  }
}

// ---- todowrite 清单渲染 ----

/** 待办状态图标：进行中 → 转圈；完成 → 勾；待办 → 空心圈 */
function todo_icon(status) {
  switch (status) {
    case 'in_progress':
      return 'lucide:loader-2'
    case 'completed':
      return 'lucide:check-circle-2'
    default:
      return 'lucide:circle'
  }
}

function todo_spin(status) {
  return status === 'in_progress'
}

function todo_priority_label(priority) {
  switch (priority) {
    case 'high':
      return '高'
    case 'low':
      return '低'
    default:
      return '中'
  }
}

function todo_priority_class(priority) {
  return priority === 'high' || priority === 'low' ? priority : 'medium'
}
</script>

<template>
  <div class="message" :class="{ user: isUser }">
    <div class="avatar">
      <Icon :icon="isUser ? 'lucide:user' : 'lucide:bot'" width="15" />
    </div>
    <div class="message-body" :class="{ 'user-card': isUser }">
      <!-- 用户消息：回退操作（悬停显示，右上角） -->
      <button
        v-if="isUser"
        class="revert-btn"
        title="回退到该消息之前：恢复文件状态和对话记录"
        @click="emit('revert', messageId)"
      >
        <Icon icon="lucide:rotate-ccw" width="12" />
      </button>
      <template v-if="parts.length === 0">
        <div v-if="summary" class="markdown-body" v-html="md_text(summary)"></div>
        <p v-else-if="isUser" class="plain-text muted">…</p>
        <!-- 兜底占位：AI 已响应但 parts 尚未生成内容时，避免只剩一条空白线 -->
        <div v-else class="thinking-placeholder">
          <Icon icon="lucide:loader-2" width="13" />
          <span>AI 正在思考…</span>
        </div>
      </template>
      <template v-else>
        <div v-for="(part, idx) in parts" :key="part.id ?? idx" class="part" :class="part.type">
          <!-- 文本：统一渲染 markdown（AI 与用户消息） -->
          <div
            v-if="part.type === 'text' && part.text"
            class="markdown-body"
            :class="{ 'user-text': isUser }"
            v-html="md_text(part.text)"
          ></div>

          <!-- 推理摘要：思考中显示占位，有内容后展示思考过程（默认收起，可展开） -->
          <details v-if="part.type === 'reasoning' && part.text" class="reasoning">
            <summary>
              <Icon icon="lucide:brain" width="13" /> 思考过程
            </summary>
            <div class="reasoning-body markdown-body" v-html="md_text(part.text)"></div>
          </details>
          <!-- 思考中占位：reasoning part 已出现但尚无文本时，保留思考栏 -->
          <div v-else-if="part.type === 'reasoning'" class="reasoning thinking">
            <div class="thinking-head">
              <Icon icon="lucide:brain" width="13" />
              <span>正在思考…</span>
            </div>
          </div>

          <!-- 工具调用：执行中展开，完成/失败默认收起，点击头部展开 -->
          <div
            v-if="part.type === 'tool'"
            class="tool-call"
            :class="tool_status(part)"
            :data-open="tool_open(part, idx)"
          >
            <div class="tool-head" role="button" tabindex="0" @click="toggle_tool(part, idx)" @keydown.enter="toggle_tool(part, idx)">
              <Icon :icon="partIcon('tool')" width="13" class="tool-icon" />
              <span class="tool-name mono">{{ tool_label(part) }}</span>
              <span class="tool-state" :title="part.status">
                <Icon
                  v-if="tool_status(part) === 'run'"
                  icon="lucide:loader-2"
                  width="12"
                  class="spin"
                />
                <Icon v-else-if="tool_status(part) === 'ok'" icon="lucide:check" width="12" />
                <Icon v-else-if="tool_status(part) === 'fail'" icon="lucide:x" width="12" />
                <Icon v-else icon="lucide:clock" width="12" />
              </span>
              <!-- 无可展开内容（read/write/webfetch）时不显示箭头 -->
              <Icon
                v-if="!compact_tool(part)"
                icon="lucide:chevron-down"
                width="12"
                class="tool-chevron"
                :class="{ rotated: tool_open(part, idx) }"
              />
            </div>
            <!-- 执行中标题（如：正在创建文件…） -->
            <div v-if="tool_status(part) === 'run' && part.title" class="tool-progress">
              {{ part.title }}
            </div>
            <!-- 任务清单（todowrite）：结构化渲染，不再输出整段 JSON -->
            <div v-if="part.todos?.length" class="todo-list" :class="tool_status(part)">
              <div
                v-for="todo in part.todos"
                :key="todo.content"
                class="todo-item"
                :class="todo.status"
              >
                <Icon
                  :icon="todo_icon(todo.status)"
                  width="12"
                  class="todo-check"
                  :class="{ spin: todo_spin(todo.status) }"
                />
                <span class="todo-text">{{ todo.content }}</span>
                <span class="todo-priority" :class="todo_priority_class(todo.priority)">
                  {{ todo_priority_label(todo.priority) }}
                </span>
              </div>
            </div>
            <!-- AI 提问（question）：未回答显示选项；已回答直接显示用户回答（含自定义） -->
            <div v-else-if="part.questions?.length" class="question-cards">
              <template v-if="part.answers?.length">
                <div v-for="(q, qi) in part.questions" :key="q.question" class="question-card answered">
                  <div class="q-head">
                    <Icon icon="lucide:help-circle" width="14" class="q-icon" />
                    <span class="q-header">{{ q.header || 'AI 提问' }}</span>
                  </div>
                  <p class="q-text">{{ q.question }}</p>
                  <div class="q-answer">
                    <Icon icon="lucide:message-circle" width="13" class="q-answer-icon" />
                    <span class="q-answer-text">{{ (part.answers[qi] ?? []).join('、') || '未回答' }}</span>
                  </div>
                </div>
              </template>
              <template v-else>
                <div v-for="q in part.questions" :key="q.question" class="question-card">
                  <div class="q-head">
                    <Icon icon="lucide:help-circle" width="14" class="q-icon" />
                    <span class="q-header">{{ q.header || 'AI 提问' }}</span>
                  </div>
                  <p class="q-text">{{ q.question }}</p>
                  <div v-if="q.options?.length" class="q-options">
                    <div v-for="opt in q.options" :key="opt.label" class="q-option">
                      <span class="q-option-label">{{ opt.label }}</span>
                      <span v-if="opt.description" class="q-option-desc">{{ opt.description }}</span>
                    </div>
                  </div>
                </div>
              </template>
            </div>
            <!-- 文件内容预览（read/write 不展示，仅 read/edit 有内容且需展开查看） -->
            <pre
              v-else-if="!compact_tool(part) && tool_open(part, idx) && part.file_content"
              class="tool-output file-preview"
              :class="{ error: tool_status(part) === 'fail' }"
            >{{ part.file_content }}</pre>
            <!-- 结果输出（read/write 不展示） -->
            <pre
              v-else-if="!compact_tool(part) && tool_open(part, idx) && tool_result(part)"
              class="tool-output"
              :class="{ error: tool_status(part) === 'fail' }"
            >{{ tool_result(part) }}</pre>
          </div>

          <!-- 步骤完成：显示本条消息总耗时 -->
          <div v-if="part.type === 'step-finish'" class="step-line">
            <Icon :icon="partIcon('step-finish')" width="13" />
            <span>完成{{ part.reason ? `（${part.reason}）` : '' }}</span>
            <span v-if="msg_elapsed" class="step-duration mono" :title="'本条消息总耗时'">
              {{ msg_elapsed }}
            </span>
          </div>

          <!-- 子任务 / 重试 / 文件 -->
          <div v-if="part.type === 'subtask'" class="step-line">
            <Icon :icon="partIcon('subtask')" width="13" />
            <span>子任务 {{ part.agent }}：{{ part.prompt }}</span>
          </div>
          <div v-if="part.type === 'retry'" class="step-line warning-text">
            <Icon :icon="partIcon('retry')" width="13" />
            <span>重试：{{ part.reason }}</span>
          </div>
          <div v-if="part.type === 'file'" class="step-line">
            <Icon :icon="partIcon('file')" width="13" />
            <span class="mono">{{ part.filename }}</span>
          </div>

          <!-- 错误 -->
          <div v-if="part.type === 'error'" class="error-line">
            <Icon icon="lucide:alert-triangle" width="13" />
            <span>{{ part.error }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.message {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) 0;
}

.message.user {
  flex-direction: row-reverse;
}

.message.user .avatar {
  background: var(--accent);
  color: #fff;
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
  box-shadow: var(--shadow);
}

.message-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

/* 用户消息卡片：右对齐气泡，与 AI 消息区分 */
.message.user .message-body.user-card {
  position: relative;
  align-self: flex-end;
  max-width: 88%;
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
}

/* 回退按钮：悬停用户消息时显示 */
.revert-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 150ms ease-out,
    color 150ms ease-out,
    border-color 150ms ease-out;
}

.message.user:hover .revert-btn,
.revert-btn:focus-visible {
  opacity: 1;
}

.revert-btn:hover {
  color: var(--danger);
  border-color: #fecaca;
  background: var(--danger-soft);
}

.plain-text {
  margin: 0;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: var(--text-sm);
}

.plain-text.muted {
  color: var(--text-muted);
}

/* ---------- Markdown 渲染（v-html 注入内容，需 :deep） ---------- */
.markdown-body {
  font-size: var(--text-sm);
  line-height: 1.65;
  word-break: break-word;
}

.markdown-body :deep(p) {
  margin: 0 0 var(--space-2);
}

.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: var(--space-3) 0 var(--space-2);
  font-weight: 600;
  line-height: 1.4;
}

.markdown-body :deep(h1) { font-size: 18px; }
.markdown-body :deep(h2) { font-size: 16px; }
.markdown-body :deep(h3) { font-size: 15px; }
.markdown-body :deep(h4) { font-size: var(--text-sm); }

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0 0 var(--space-2);
  padding-left: var(--space-5);
}

.markdown-body :deep(li) {
  margin: var(--space-1) 0;
}

.markdown-body :deep(a) {
  color: var(--accent);
}

.markdown-body :deep(strong) {
  font-weight: 600;
}

.markdown-body :deep(blockquote) {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--accent);
  color: var(--text-secondary);
  background: var(--accent-soft);
  border-radius: 0 var(--radius) var(--radius) 0;
}

.markdown-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--text);
}

.markdown-body :deep(pre) {
  margin: var(--space-2) 0;
  padding: var(--space-3);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow-x: auto;
}

.markdown-body :deep(pre code) {
  display: block;
  background: transparent;
  border: none;
  padding: 0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
  color: var(--text);
}

.markdown-body :deep(table) {
  margin: var(--space-2) 0;
  border-collapse: collapse;
  font-size: var(--text-xs);
  width: 100%;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: var(--space-1) var(--space-2);
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--surface-sunken);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  margin: var(--space-3) 0;
  border: none;
  border-top: 1px solid var(--border);
}

.reasoning {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface-sunken);
}

.reasoning summary {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--surface-sunken);
  user-select: none;
  transition: background-color var(--transition);
}

.reasoning summary:hover {
  background: var(--bg-hover);
}

.reasoning summary::-webkit-details-marker {
  display: none;
}

.reasoning summary::marker {
  content: '';
}

.reasoning summary::after {
  content: '';
  margin-left: auto;
  width: 0;
  height: 0;
  border-left: 4px solid var(--text-muted);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transform: rotate(90deg);
  transition: transform var(--transition);
}

.reasoning[open] summary::after {
  transform: rotate(-90deg);
}

.reasoning-body {
  padding: var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  background: var(--surface);
  border-top: 1px solid var(--border);
  line-height: 1.65;
}

.reasoning-body :deep(p) {
  margin: 0 0 var(--space-1);
}

.reasoning-body :deep(p:last-child) {
  margin-bottom: 0;
}

/* 思考中占位：reasoning part 尚无文本时保留思考栏 */
.reasoning.thinking {
  padding: var(--space-2) var(--space-3);
}

.thinking-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.thinking-head::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
}

/* 整条消息无任何内容时的思考占位 */
.thinking-placeholder {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-sunken);
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.thinking-placeholder :deep(svg) {
  color: var(--accent);
  animation: spin 1s linear infinite;
}

/* 用户消息的 markdown 文本：与 AI 文本保持一致的排版 */
.user-text {
  color: var(--text);
}

.tool-call {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--shadow);
  transition: border-color var(--transition);
}

.tool-call.run {
  border-color: var(--accent-soft);
}

.tool-call.fail {
  border-color: #fecaca;
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-sunken);
  font-size: var(--text-xs);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--transition);
}

.tool-head:hover {
  background: var(--bg-hover);
}

.tool-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.tool-chevron {
  color: var(--text-muted);
  transition: transform var(--transition);
  flex-shrink: 0;
}

.tool-chevron.rotated {
  transform: rotate(180deg);
}

.tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--text-secondary);
}

.tool-state {
  color: var(--text-muted);
  display: flex;
  flex-shrink: 0;
}

.tool-call.ok .tool-state { color: var(--success); }
.tool-call.fail .tool-state { color: var(--danger); }
.tool-call.run .tool-icon { color: var(--accent); }
.tool-call.run .tool-name { color: var(--text); }

.tool-progress {
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  background: var(--surface-sunken);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tool-progress::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
  animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* ---------- todowrite 任务清单 ---------- */
.todo-list {
  border-top: 1px solid var(--border);
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--surface-sunken);
}

.todo-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 6px;
  font-size: var(--text-xs);
  border-radius: 4px;
  line-height: 1.5;
}

.todo-check {
  flex-shrink: 0;
  color: var(--text-muted);
}

.todo-item.in_progress .todo-check {
  color: var(--accent);
}

.todo-item.completed .todo-check {
  color: var(--success);
}

.todo-item.completed .todo-text {
  color: var(--text-muted);
  text-decoration: line-through;
}

.todo-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  color: var(--text-secondary);
}

.todo-item.in_progress .todo-text {
  color: var(--text);
}

.todo-priority {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-muted);
  border: 1px solid var(--border);
}

.todo-priority.high {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: #fecaca;
}

.todo-priority.low {
  color: var(--text-secondary);
}

/* ---------- AI 提问（question 工具） ---------- */
.question-cards {
  border-top: 1px solid var(--border);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--surface-sunken);
}

.question-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  padding: var(--space-3);
  box-shadow: var(--shadow);
}

.q-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text);
}

.q-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.q-header {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.q-text {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}

.q-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.q-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.q-option-label {
  font-size: var(--text-xs);
  color: var(--text);
  font-weight: 500;
}

/* 已回答的提问：直接展示用户回答（含自定义答案），不再显示选项 */
.question-card.answered {
  border-color: var(--success);
}

.q-answer {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
}

.q-answer-icon {
  color: var(--success);
  flex-shrink: 0;
  margin-top: 1px;
}

.q-option-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* ---------- 文件内容预览 ---------- */
.tool-output.file-preview {
  background: var(--surface-sunken);
  color: var(--text);
  max-height: 320px;
}

.tool-output {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.tool-output.error {
  color: var(--danger);
  background: var(--danger-soft);
}

.step-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  padding: var(--space-1) 0;
}

/* 「完成」行旁的耗时徽章 */
.step-duration {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1.5;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.step-line.warning-text {
  color: var(--warning);
}

.error-line {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--danger-soft);
  border: 1px solid #fecaca;
  border-radius: var(--radius-md);
  color: var(--danger);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.error-line :deep(svg) {
  flex-shrink: 0;
  margin-top: 1px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
