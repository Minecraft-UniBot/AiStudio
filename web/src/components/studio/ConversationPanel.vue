<script setup>
// 对话面板（Plan 3.2 中栏）：消息时间线 + 待处理权限/问题 + 输入区
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue'
import { Icon } from '@iconify/vue'
import MessagePart from './MessagePart.vue'
import PermissionRequest from './PermissionRequest.vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'

const props = defineProps({
  draftId: { type: String, required: true },
  messages: { type: Array, default: () => [] },
  pendingPermissions: { type: Array, default: () => [] },
  pendingQuestions: { type: Array, default: () => [] },
  /** 会话忙碌（规划/编码中），发送按钮切换为停止 */
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['send', 'stop', 'reply-permission', 'reply-question', 'reject-question', 'revert-message'])

const input = ref('')
const sending = ref(false)
const scrollEl = ref(null)
const messageEl = ref(null)

// ---- question 回答状态（按 `${questionId}:${questionIndex}` 记录） ----
const selections = ref({}) // -> Set<string>（已选选项 label）
const customAnswers = ref({}) // -> string（自定义输入）

function optKey(questionId, qi) {
  return `${questionId}:${qi}`
}

function isSelected(questionId, qi, label) {
  return selections.value[optKey(questionId, qi)]?.has(label) ?? false
}

function toggleOption(questionId, qi, item, label) {
  const key = optKey(questionId, qi)
  const next = new Set(selections.value[key] ?? [])
  if (item.multiple) {
    if (next.has(label)) next.delete(label)
    else next.add(label)
  } else {
    // 单选：再次点击已选项取消；否则替换为当前项
    if (next.has(label) && next.size === 1) next.delete(label)
    else {
      next.clear()
      next.add(label)
    }
  }
  selections.value[key] = next
}

/** 每题必须已有回答（选了选项或填了自定义），才能提交 */
function canSubmit(question) {
  return question.questions.every((item, qi) => {
    const key = optKey(question.id, qi)
    if ((customAnswers.value[key] ?? '').trim().length > 0) return true
    if (!item.options?.length) return false
    return (selections.value[key]?.size ?? 0) > 0
  })
}

/** 收集每题回答（自定义输入优先，否则为选中的选项 label 列表）并提交 */
function submit(question) {
  const answers = question.questions.map((item, qi) => {
    const key = optKey(question.id, qi)
    const custom = (customAnswers.value[key] ?? '').trim()
    if (custom) return [custom]
    return Array.from(selections.value[key] ?? [])
  })
  emit('reply-question', question, answers)
}

function reject(question) {
  emit('reject-question', question)
}

const can_send = computed(() => input.value.trim().length > 0 && !sending.value && !props.busy)
const placeholder = computed(() =>
  props.busy ? 'AI 正在处理中…' : '继续描述需求、提出修改，或询问扩展用法…（Enter 发送，Shift+Enter 换行）',
)

// ---- 消息导航：提取用户消息位置，支持快速跳转 ----
const user_messages = computed(() =>
  props.messages
    .filter((m) => m.info?.role === 'user')
    .map((m, i) => ({
      id: m.info?.id ?? '',
      index: i + 1,
      text: (m.info?.content ?? '').slice(0, 40),
    })),
)

function scrollToMessage(messageId) {
  const el = document.getElementById(`msg-${messageId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // 闪烁高亮效果
    el.classList.add('msg-highlight')
    setTimeout(() => el.classList.remove('msg-highlight'), 1500)
  }
}

/** 距底部多少像素内视为「在底部」 */
const BOTTOM_THRESHOLD = 56
/** 用户离开底部后，静默多久自动滚回底部（毫秒） */
const FOLLOW_IDLE_MS = 5000

const near_bottom = ref(true)
let follow_timer = null

function is_near_bottom() {
  const el = scrollEl.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
}

/**
 * 滚动到底部。
 * - smooth=false（默认）：即时跳转，用于流式跟随——平滑动画在 200ms 级的高频刷新下
 *   会被不断打断重来，滚动位置追不上增长的底部；
 * - smooth=true：平滑滚动，用于挂载和「离开底部后自动回底」（距离大，柔和过渡更自然）。
 */
function scrollToBottom(smooth = false) {
  nextTick(() => {
    const el = scrollEl.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  })
}

/** 用户离开底部后保持不打扰：以「最后一次滚动」为基准，静默 5s 后自动滚回底部 */
function arm_follow_timer() {
  if (follow_timer) return // 已在计时，只等用户 5s 无动静
  follow_timer = setTimeout(() => {
    follow_timer = null
    if (!near_bottom.value) scrollToBottom(true)
  }, FOLLOW_IDLE_MS)
}

/** 重新武装：从最后一次滚动开始重新计算 5s 静默窗口 */
function reset_follow_timer() {
  cancel_follow_timer()
  arm_follow_timer()
}

function cancel_follow_timer() {
  clearTimeout(follow_timer)
  follow_timer = null
}

/**
 * 用户滚动：更新是否在底部。
 * - 回到底部 → 取消待执行的自动滚动；
 * - 仍离开底部且有待执行的回底计划 → 重置静默倒计时（而不是取消）。
 *   旧实现一滚动就 cancel，用户看历史时 5s 内滚动任意一格就会让自动回底永久失效，
 *   之后一直闲着也不会再触发——「5s 无任何滚动操作再自动回底」实际无效。
 */
function onScroll() {
  near_bottom.value = is_near_bottom()
  if (near_bottom.value) {
    cancel_follow_timer()
  } else if (follow_timer) {
    reset_follow_timer()
  }
}

// 滚动跟随：新消息追加，或最后一条消息内容更新（工具输出 / 文本流式刷新）时
// - 用户在底部 → 即时跳转到底部（流式更新下平滑动画追不上，用 auto 保证始终贴底）
// - 用户不在底部（正在看历史）→ 不打扰；5s 无任何滚动操作再平滑滚回底部
watch(
  () => props.messages[props.messages.length - 1],
  () => {
    if (near_bottom.value) scrollToBottom()
    else arm_follow_timer()
  },
)

onMounted(() => scrollToBottom(true))
onUnmounted(cancel_follow_timer)

async function send() {
  const text = input.value.trim()
  if (!text || sending.value || props.busy) return
  sending.value = true
  input.value = ''
  emit('send', text, () => {
    // 发送失败时由父级回填输入
  })
  // 发送后允许立即输入下一条（后端生成中会禁用）
  sending.value = false
}

function onKeydown(e) {
  if (e.isComposing) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
</script>

<template>
  <main class="conversation-panel">
    <div ref="scrollEl" class="message-scroll" @scroll="onScroll">
      <!-- 消息流 -->
      <EmptyState
        v-if="messages.length === 0"
        icon="lucide:sparkles"
        title="AI 正在创建扩展"
        description="基于你的描述自动生成清单、配置和实现"
      />
      <MessagePart
        v-for="msg in messages"
        :key="msg.info?.id"
        :message="msg"
        @revert="(messageId) => emit('revert-message', messageId)"
      />
      <div ref="messageEl" />
    </div>

    <!-- 消息导航浮标：用户消息 ≥3 条时显示，点击快速跳转到指定用户消息 -->
    <div v-if="user_messages.length >= 3" class="msg-nav">
      <button
        v-for="msg in user_messages"
        :key="msg.id"
        class="msg-nav-dot"
        :title="`#${msg.index} ${msg.text}`"
        @click="scrollToMessage(msg.id)"
      >
        <span class="msg-nav-num">{{ msg.index }}</span>
      </button>
    </div>

    <!-- 待处理授权 / 提问：固定在输入框上方，AI 卡住时无需滚动即可处理 -->
    <div v-if="pendingPermissions.length || pendingQuestions.length" class="pending-bar">
      <div class="pending-bar-head">
        <span class="pending-bar-dot" />
        <span>需要你处理</span>
      </div>
      <div class="pending-list">
        <div v-for="permission in pendingPermissions" :key="permission.id" class="pending-item">
          <PermissionRequest
            :draft-id="draftId"
            :permission="permission"
            @reply="(response) => emit('reply-permission', permission, response)"
          />
        </div>
        <!-- 待处理问题（question 工具：选择选项或输入自定义答案后提交，模型才会继续） -->
        <div v-for="question in pendingQuestions" :key="question.id" class="pending-item question-card">
          <div class="q-head">
            <div class="q-icon-wrap">
              <Icon icon="lucide:help-circle" width="15" class="q-icon" />
            </div>
            <span class="q-title">AI 需要你确认</span>
          </div>
          <div v-for="(item, qi) in question.questions" :key="qi" class="q-item">
            <p class="q-prompt">{{ item.question }}</p>
            <div v-if="item.options?.length" class="q-options">
              <button
                v-for="opt in item.options"
                :key="opt.label"
                type="button"
                class="q-option-btn"
                :class="{ selected: isSelected(question.id, qi, opt.label) }"
                @click="toggleOption(question.id, qi, item, opt.label)"
              >
                <span class="q-radio" />
                <span class="q-option-text">
                  <span class="q-option-label">{{ opt.label }}</span>
                  <span v-if="opt.description" class="q-option-desc">{{ opt.description }}</span>
                </span>
              </button>
            </div>
            <input
              v-if="item.custom"
              v-model="customAnswers[`${question.id}:${qi}`]"
              class="q-custom"
              type="text"
              placeholder="输入自定义答案…"
            />
          </div>
          <div class="q-actions">
            <Button size="sm" variant="secondary" @click="reject(question)">忽略</Button>
            <Button size="sm" variant="primary" :disabled="!canSubmit(question)" @click="submit(question)">
              提交回答
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 输入区：生成中切换为停止按钮（Plan 3.2） -->
    <div class="input-area" :class="{ busy }">
      <div class="input-wrap">
        <textarea
          v-model="input"
          class="chat-input"
          rows="2"
          :placeholder="placeholder"
          :disabled="busy"
          @keydown="onKeydown"
        />
        <div class="input-hint">
          <span class="hint-text">
            <Icon icon="lucide:corner-down-left" width="11" />
            发送
            <Icon icon="lucide:arrow-up-down" width="11" class="hint-sep" />
            换行
          </span>
        </div>
      </div>
      <Button
        v-if="busy"
        variant="danger"
        icon-only
        class="send-btn"
        title="停止生成"
        @click="emit('stop')"
      >
        <Icon icon="lucide:square" width="15" />
      </Button>
      <Button
        v-else
        variant="primary"
        icon-only
        class="send-btn"
        :disabled="!can_send"
        title="发送"
        @click="send"
      >
        <Icon icon="lucide:arrow-up" width="16" />
      </Button>
    </div>
  </main>
</template>

<style scoped>
.conversation-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
  position: relative;
}

.message-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* ---------- 消息导航浮标 ---------- */
.msg-nav {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  z-index: 10;
}

.msg-nav-dot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--transition),
    color var(--transition),
    border-color var(--transition),
    transform var(--transition);
  box-shadow: var(--shadow);
}

.msg-nav-dot:hover {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
  transform: scale(1.15);
}

.msg-nav-num {
  line-height: 1;
}

/* 用户消息高亮闪烁（跳转后短暂标记） */
.msg-highlight {
  animation: msg-flash 1.5s ease-out;
}

@keyframes msg-flash {
  0% { background: var(--accent-soft); }
  100% { background: transparent; }
}

/* ---------- 待处理授权 / 提问：固定在输入框上方的处理条 ---------- */
.pending-bar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 45%;
  background: var(--surface-sunken);
  border-top: 1px solid var(--border);
  box-shadow: 0 -6px 16px rgb(0 0 0 / 0.05);
  z-index: 1;
}

.pending-bar-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.pending-bar-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warning);
  animation: pending-pulse 1.6s ease-in-out infinite;
}

@keyframes pending-pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgb(217 119 6 / 0.35);
  }
  50% {
    opacity: 0.75;
    box-shadow: 0 0 0 5px rgb(217 119 6 / 0);
  }
}

.pending-list {
  overflow-y: auto;
  padding: var(--space-3) var(--space-4) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.pending-item {
  flex-shrink: 0;
}

.question-card {
  border: 1px solid #c7d7f7;
  background: linear-gradient(180deg, #f8fbff 0%, #ffffff 78%);
  border-radius: var(--radius-lg);
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  box-shadow: 0 2px 8px rgb(37 99 235 / 0.07);
}

.q-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--accent);
}

.q-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  border: 1px solid #dbe7fd;
  flex-shrink: 0;
  color: var(--accent);
}

.q-title {
  line-height: 1.4;
}

.q-icon {
  flex-shrink: 0;
}

.q-prompt {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--text);
  word-break: break-word;
}

.q-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.q-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.q-option-btn {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition),
    background-color var(--transition),
    box-shadow var(--transition);
}

.q-option-btn:hover {
  border-color: var(--border-strong);
  background: var(--surface-sunken);
}

.q-option-btn.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent);
}

/* 单选指示点 */
.q-radio {
  width: 15px;
  height: 15px;
  margin-top: 2px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  background: var(--surface);
  flex-shrink: 0;
  transition:
    border-color var(--transition),
    background-color var(--transition),
    box-shadow var(--transition);
}

.q-option-btn:hover .q-radio {
  border-color: var(--accent);
}

.q-option-btn.selected .q-radio {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 3px var(--surface);
}

.q-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.q-option-label {
  font-weight: 500;
}

.q-option-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
}

.q-custom {
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--text);
  outline: none;
  transition: border-color var(--transition), box-shadow var(--transition);
}

.q-custom:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 0.12);
}

.q-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  justify-content: flex-end;
  padding-top: 2px;
}

/* ---------- 输入区 ---------- */
.input-area {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--border);
  background: var(--surface);
  align-items: flex-end;
}

.input-area.busy {
  background: var(--surface-sunken);
}

.input-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  transition:
    border-color var(--transition),
    box-shadow var(--transition);
}

.input-wrap:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.input-area.busy .input-wrap {
  background: var(--surface-sunken);
  border-color: var(--border);
}

.chat-input {
  display: block;
  width: 100%;
  resize: none;
  border: none;
  background: transparent;
  padding: var(--space-3) var(--space-3) var(--space-2);
  font-size: var(--text-sm);
  font-family: var(--font-body);
  line-height: 1.6;
  color: var(--text);
  outline: none;
}

.chat-input::placeholder {
  color: var(--text-muted);
}

.chat-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.input-hint {
  display: flex;
  justify-content: flex-end;
  padding: 0 var(--space-3) var(--space-2);
}

.hint-text {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1;
}

.hint-sep {
  margin: 0 2px;
  opacity: 0.6;
}

.send-btn {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
}
</style>
