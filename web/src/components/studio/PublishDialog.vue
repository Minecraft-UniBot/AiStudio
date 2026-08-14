<script setup>
// 发布确认对话框（Plan 3.4：只列出功能摘要、使用方式、配置项和重启提示）
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import Dialog from '@/components/ui/Dialog.vue'

const open = defineModel({ type: Boolean, default: false })

const props = defineProps({
  draft: { type: Object, required: true },
  publishing: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm'])

const reviewSummary = computed(() => props.draft.review?.summary ?? '')
</script>

<template>
  <Dialog
    v-model="open"
    title="确认发布"
    description="发布采用原子交付；目标 ID 已存在时拒绝覆盖"
    confirm-text="一键发布到 UniBot"
    :loading="publishing"
    @confirm="$emit('confirm')"
  >
    <div class="publish-summary">
      <div class="summary-row">
        <span class="label">扩展</span>
        <span class="value mono">{{ draft.name }}（{{ draft.extension_id }}）</span>
      </div>
      <div class="summary-row">
        <span class="label">功能描述</span>
        <span class="value">{{ draft.description }}</span>
      </div>
      <div class="summary-row">
        <span class="label">类型</span>
        <span class="value">{{ draft.types.join('、') }}</span>
      </div>
      <div class="summary-row">
        <span class="label">审核摘要</span>
        <span class="value">{{ reviewSummary || '—' }}</span>
      </div>
      <details class="tech-detail">
        <summary>
          <Icon icon="lucide:chevron-down" width="13" />
          技术详情（校验步骤与文件摘要）
        </summary>
        <div class="tech-body">
          <p v-for="step in draft.validation?.steps ?? []" :key="step.id" class="tech-step">
            <Icon
              :icon="step.status === 'passed' ? 'lucide:check' : 'lucide:x'"
              width="12"
              :class="step.status"
            />
            {{ step.name }}
            <span v-if="step.status !== 'passed'" class="tech-fail">未通过</span>
          </p>
          <p class="tech-revision mono">
            文件摘要 {{ (draft.validation_revision ?? '').slice(0, 12) }}…
          </p>
        </div>
      </details>
      <p class="restart-hint">
        <Icon icon="lucide:info" width="14" />
        发布后需要<strong>重启 UniBot</strong>，扩展才会出现在已安装列表并生效。
      </p>
    </div>
  </Dialog>
</template>

<style scoped>
.publish-summary {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.summary-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.summary-row .label {
  font-size: 11.5px;
  color: var(--text-muted);
}

.summary-row .value {
  font-size: 13.5px;
  line-height: 1.55;
}

.tech-detail {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
}

.tech-detail summary {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.tech-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.tech-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  margin: 0;
}

.tech-step svg.passed {
  color: var(--success);
}

.tech-step svg.failed {
  color: var(--danger);
}

.tech-fail {
  color: var(--danger);
}

.tech-revision {
  font-size: 11.5px;
  color: var(--text-muted);
}

.restart-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 10px 12px;
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  border-radius: var(--radius);
  font-size: 13px;
  color: #92400e;
  line-height: 1.5;
}

.restart-hint svg {
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
