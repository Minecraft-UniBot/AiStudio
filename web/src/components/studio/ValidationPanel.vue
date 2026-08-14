<script setup>
// 校验面板：运行校验 / AI 审核 / 自动修复 + 步骤状态（Plan 3.4、8.3）
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'

const props = defineProps({
  draft: { type: Object, required: true },
  validating: { type: Boolean, default: false },
  reviewing: { type: Boolean, default: false },
  repairing: { type: Boolean, default: false },
})

const emit = defineEmits(['validate', 'review', 'debug'])

const validation = computed(() => props.draft.validation)
const review = computed(() => props.draft.review)
const mustFixCount = computed(
  () => review.value?.issues?.filter((issue) => issue.severity === 'must_fix').length ?? 0,
)
/** 校验失败且未在修复中 → 显示「自动修复」（Plan 3.4） */
const canRepair = computed(
  () => validation.value?.status === 'failed' && !props.validating && !props.repairing,
)
/** 审核存在 must_fix 且未在调试中 → 显示「自动修复」（Plan 3.5） */
const canDebug = computed(
  () =>
    mustFixCount.value > 0 &&
    props.draft.status === 'reviewing' &&
    !props.validating &&
    !props.repairing,
)

function stepIcon(status) {
  if (status === 'passed') return 'lucide:check-circle-2'
  if (status === 'failed') return 'lucide:x-circle'
  if (status === 'running') return 'lucide:loader-2'
  return 'lucide:circle'
}
</script>

<template>
  <div class="validation-panel">
    <div class="check-actions">
      <Button :loading="validating" @click="emit('validate')">
        <Icon
          :icon="validating ? 'lucide:loader-2' : 'lucide:shield-check'"
          width="15"
          :class="{ spin: validating }"
        />
        {{ validating ? '校验中…' : '运行校验' }}
      </Button>
      <Button :loading="reviewing" @click="emit('review')">
        <Icon
          :icon="reviewing ? 'lucide:loader-2' : 'lucide:brain'"
          width="15"
          :class="{ spin: reviewing }"
        />
        {{ reviewing ? '审核中…' : 'AI 审核' }}
      </Button>
      <Button v-if="canRepair" :loading="repairing" variant="warning" @click="emit('debug')">
        <Icon
          :icon="repairing ? 'lucide:loader-2' : 'lucide:wrench'"
          width="15"
          :class="{ spin: repairing }"
        />
        {{ repairing ? '修复中…' : '自动修复' }}
      </Button>
      <Button v-if="canDebug" :loading="repairing" @click="emit('debug')">
        <Icon
          :icon="repairing ? 'lucide:loader-2' : 'lucide:wrench'"
          width="15"
          :class="{ spin: repairing }"
        />
        自动修复（{{ review.round }}/{{ review.max_rounds }}）
      </Button>
    </div>

    <EmptyState
      v-if="!validation"
      icon="lucide:shield-check"
      title="尚未运行校验"
      description="点击「运行校验」检查扩展清单、语法、测试和 Loader 绑定"
    />
    <div v-else class="step-list">
      <div v-for="step in validation.steps" :key="step.id" class="step-item">
        <Icon
          :icon="stepIcon(step.status)"
          width="15"
          :class="[step.status, { spin: step.status === 'running' }]"
        />
        <div class="step-body">
          <span class="step-name">{{ step.name }}</span>
          <span v-if="step.message" class="step-msg">{{ step.message }}</span>
          <details v-if="step.detail" class="step-detail">
            <summary>技术详情</summary>
            <pre>{{ step.detail }}</pre>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.check-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3) 0;
}

.step-item {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  align-items: flex-start;
  transition: background-color var(--transition);
}

.step-item:hover {
  background: var(--surface-sunken);
}

.step-item > svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.step-item > svg.passed {
  color: var(--success);
}

.step-item > svg.failed {
  color: var(--danger);
}

.step-item > svg.running {
  color: var(--accent);
}

.step-item > svg.pending {
  color: var(--text-muted);
}

.step-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.step-name {
  font-weight: 500;
}

.step-msg {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.step-detail summary {
  font-size: var(--text-xs);
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.step-detail pre {
  margin: var(--space-1) 0 0;
  padding: var(--space-2);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
  color: var(--text-secondary);
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
