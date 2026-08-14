<script setup>
// 对话面板（Plan 3.2 中栏）：消息时间线 + 待处理权限/问题 + 输入区
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Icon } from '@iconify/vue'
import MessagePart from './MessagePart.vue'
import PermissionRequest from './PermissionRequest.vue'
import Button from '@/components/ui/Button.vue'

const props = defineProps({
  draftId: { type: String, required: true },
  messages: { type: Array, default: () => [] },
  pendingPermissions: { type: Array, default: () => [] },
  pendingQuestions: { type: Array, default: () => [] },
  /** 会话忙碌（生成/修复/调试中），发送按钮切换为停止 */
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['send', 'stop', 'reply-permission', 'reply-question', 'revert-message'])

const input = ref('')
const sending = ref(false)
const scrollEl = ref(null)
const messageEl = ref(null)

function scrollToBottom() {
  nextTick(() => {
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight })
  })
}

watch(
  () => props.messages.length,
  () => scrollToBottom(),
)

// 新权限/问题出现时滚到底部
watch(
  () => [props.pendingPermissions.length, props.pendingQuestions.length],
  () => scrollToBottom(),
)

onMounted(scrollToBottom)
onUnmounted(() => {})

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

function replyQuestion(question, answer) {
  emit('reply-question', question, answer)
}
</script>

<template>
  <main class="conversation-panel">
    <div ref="scrollEl" class="message-scroll">
      <!-- 待处理权限 -->
      <div v-for="permission in pendingPermissions" :key="permission.id" class="pending-item">
        <PermissionRequest
          :draft-id="draftId"
          :permission="permission"
          @reply="(response) => emit('reply-permission', permission, response)"
        />
      </div>
      <!-- 待处理问题 -->
      <div v-for="question in pendingQuestions" :key="question.id" class="pending-item question-card">
        <div class="q-head">
          <Icon icon="lucide:help-circle" width="15" class="q-icon" />
          <span>{{ question.prompt }}</span>
        </div>
        <div class="q-actions">
          <Button v-for="choice in question.choices" :key="choice" size="sm" @click="replyQuestion(question, choice)">
            {{ choice }}
          </Button>
        </div>
      </div>
      <!-- 消息流 -->
      <div v-if="messages.length === 0" class="empty-chat">
        <Icon icon="lucide:sparkles" width="26" />
        <p>AI 正在基于你的描述创建扩展…</p>
      </div>
      <MessagePart
        v-for="msg in messages"
        :key="msg.info?.id"
        :message="msg"
        @revert="(messageId) => emit('revert-message', messageId)"
      />
      <div ref="messageEl" />
    </div>

    <!-- 输入区：生成中切换为停止按钮（Plan 3.2） -->
    <div class="input-area">
      <textarea
        v-model="input"
        class="chat-input"
        rows="2"
        :placeholder="busy ? 'AI 正在处理中…' : '继续描述需求、提出修改，或询问扩展用法…'"
        :disabled="busy"
        @keydown.enter.exact.prevent="send"
      />
      <button
        v-if="busy"
        class="send-btn stop"
        title="停止生成"
        @click="emit('stop')"
      >
        <Icon icon="lucide:square" width="15" />
      </button>
      <button
        v-else
        class="send-btn"
        :class="{ primary: input.trim() }"
        :disabled="!input.trim()"
        @click="send"
      >
        <Icon icon="lucide:send" width="16" />
      </button>
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
}

.message-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pending-item {
  margin-bottom: 4px;
}

.question-card {
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.q-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13.5px;
  line-height: 1.5;
}

.q-icon {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}

.q-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.empty-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 13.5px;
}

.empty-chat p {
  margin: 0;
}

.input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.chat-input {
  flex: 1;
  resize: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 12px;
  font-size: var(--text-sm);
  font-family: var(--font-body);
  line-height: 1.5;
  color: var(--text);
  background: var(--surface);
  outline: none;
  transition: border-color var(--transition), box-shadow var(--transition);
}

.chat-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgb(37 99 235 / 0.12);
}

.chat-input:disabled {
  opacity: 0.6;
}

.send-btn {
  width: 40px;
  height: 40px;
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color var(--transition),
    border-color var(--transition),
    color var(--transition);
}

.send-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text);
}

.send-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

.send-btn.stop {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
