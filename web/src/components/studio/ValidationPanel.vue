<script setup>
// 审查面板（三阶段流程第三阶段）：审查结果 + 重新审查 / 自动修复 / 让 AI 修复建议（Plan 3.5）
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import AiReviewPanel from './AiReviewPanel.vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'

const props = defineProps({
  draft: { type: Object, required: true },
  reviewing: { type: Boolean, default: false },
  repairing: { type: Boolean, default: false },
})

const emit = defineEmits(['review', 'debug'])

const review = computed(() => props.draft.review)
const mustFixCount = computed(
  () => review.value?.issues?.filter((issue) => issue.severity === 'must_fix').length ?? 0,
)
const suggestionCount = computed(
  () => review.value?.issues?.filter((issue) => issue.severity === 'suggestion').length ?? 0,
)
/** 审查存在 must_fix 且未在修复中 → 显示「自动修复」 */
const canDebug = computed(
  () =>
    mustFixCount.value > 0 &&
    props.draft.status === 'reviewing' &&
    !props.reviewing &&
    !props.repairing,
)
/**
 * 审查通过（ready）后仍有建议问题 → 显示「让 AI 修复建议」。
 * 把审查发现的 suggestion 发给 AI 继续优化，修复后自动重新审查。
 */
const canFixSuggestions = computed(
  () =>
    suggestionCount.value > 0 &&
    props.draft.status === 'ready' &&
    !props.reviewing &&
    !props.repairing,
)
/** 非忙碌阶段 → 允许手动重新审查 */
const canReview = computed(
  () =>
    !['planning', 'coding', 'debugging', 'reviewing'].includes(props.draft.status) &&
    !props.repairing,
)
</script>

<template>
  <div class="review-panel">
    <div class="review-actions">
      <Button :loading="reviewing" :disabled="!canReview" @click="emit('review')">
        <Icon
          :icon="reviewing ? 'lucide:loader-2' : 'lucide:brain'"
          width="15"
          :class="{ spin: reviewing }"
        />
        {{ reviewing ? '审查中…' : '重新审查' }}
      </Button>
      <Button v-if="canDebug" :loading="repairing" variant="warning" @click="emit('debug', false)">
        <Icon
          :icon="repairing ? 'lucide:loader-2' : 'lucide:wrench'"
          width="15"
          :class="{ spin: repairing }"
        />
        {{ repairing ? '修复中…' : `自动修复（${review?.round}/${review?.max_rounds}）` }}
      </Button>
      <Button
        v-if="canFixSuggestions"
        :loading="repairing"
        variant="secondary"
        @click="emit('debug', true)"
      >
        <Icon
          :icon="repairing ? 'lucide:loader-2' : 'lucide:sparkles'"
          width="15"
          :class="{ spin: repairing }"
        />
        {{ repairing ? '修复中…' : `让 AI 修复建议（${suggestionCount}）` }}
      </Button>
    </div>

    <AiReviewPanel :review="review" />

    <EmptyState
      v-if="!review"
      icon="lucide:brain"
      title="尚未审查"
      description="编码完成后会自动进入审查；也可以点击「重新审查」手动触发。"
    />
  </div>
</template>

<style scoped>
.review-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.review-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: var(--space-4) 0;
  border-bottom: 1px solid var(--border);
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
