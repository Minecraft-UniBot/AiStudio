<script setup>
// 消息部件渲染：文本 / 推理 / 工具调用 / 步骤 / 错误
// parts 统一经 utils/opencode_parts.js 归一化，不直接依赖 OpenCode 原始字段
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { normalize_parts, tool_status, tool_label, tool_result } from '@/utils/opencode_parts'

const props = defineProps({
  message: { type: Object, required: true },
})

const isUser = computed(() => props.message.info?.role === 'user')
const parts = computed(() => normalize_parts(props.message))
const summary = computed(() => props.message.info?.summary?.body ?? '')

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
</script>

<template>
  <div class="message" :class="{ user: isUser }">
    <div class="avatar">
      <Icon :icon="isUser ? 'lucide:user' : 'lucide:bot'" width="15" />
    </div>
    <div class="message-body">
      <template v-if="parts.length === 0">
        <p v-if="summary" class="plain-text">{{ summary }}</p>
        <p v-else-if="isUser" class="plain-text muted">…</p>
      </template>
      <template v-else>
        <div v-for="(part, idx) in parts" :key="part.id ?? idx" class="part" :class="part.type">
          <!-- 文本 -->
          <p v-if="part.type === 'text' && part.text" class="plain-text">{{ part.text }}</p>

          <!-- 推理摘要 -->
          <details v-if="part.type === 'reasoning' && part.text" class="reasoning">
            <summary>
              <Icon icon="lucide:brain" width="13" /> 思考过程
            </summary>
            <pre>{{ part.text }}</pre>
          </details>

          <!-- 工具调用 -->
          <div v-if="part.type === 'tool'" class="tool-call" :class="tool_status(part)">
            <div class="tool-head">
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
            </div>
            <!-- 执行中标题（如：正在创建文件…） -->
            <div v-if="tool_status(part) === 'run' && part.title" class="tool-progress">
              {{ part.title }}
            </div>
            <!-- 结果输出 -->
            <pre v-if="tool_result(part)" class="tool-output" :class="{ error: tool_status(part) === 'fail' }">{{ tool_result(part) }}</pre>
          </div>

          <!-- 步骤 -->
          <div v-if="part.type === 'step-start' || part.type === 'step-finish'" class="step-line">
            <Icon :icon="partIcon(part.type)" width="13" />
            <span>{{ part.type === 'step-start' ? '开始执行' : `完成${part.reason ? `（${part.reason}）` : ''}` }}</span>
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
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.message.user .avatar {
  background: var(--accent);
  color: #fff;
}

.avatar {
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  background: var(--bg-hover);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.message-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
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

.reasoning {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.reasoning summary {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  background: var(--surface-sunken);
  user-select: none;
}

.reasoning pre {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--surface-sunken);
  border-top: 1px solid var(--border);
}

.tool-call {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--surface);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  background: var(--surface-sunken);
  font-size: var(--text-xs);
}

.tool-icon {
  color: var(--text-muted);
}

.tool-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

.tool-state {
  color: var(--text-muted);
  display: flex;
  flex-shrink: 0;
}

.tool-call.ok .tool-state { color: var(--success); }
.tool-call.fail .tool-state { color: var(--danger); }
.tool-call.run .tool-icon { color: var(--accent); }

.tool-progress {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
}

.tool-output {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-xs);
  line-height: 1.5;
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
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  padding: 1px 0;
}

.step-line.warning-text {
  color: var(--warning);
}

.error-line {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  background: var(--danger-soft);
  border: 1px solid #fecaca;
  border-radius: var(--radius);
  color: var(--danger);
  font-size: var(--text-xs);
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
