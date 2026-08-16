<script setup>
// 审查面板（三阶段流程第三阶段）：审查结果 + 重新审查 / 自动修复 / 让 AI 修复建议（Plan 3.5）
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import AiReviewPanel from './AiReviewPanel.vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { use_rotating_slogan, REVIEW_SLOGANS } from '@/composables/use_rotating_slogan'

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
/**
 * 审查真正进行中：status 为 reviewing 且没有待处理的 must_fix
 * （审查结算出 must_fix 后 status 仍是 reviewing，但此时应展示「自动修复」而非标语）。
 */
const reviewRunning = computed(
  () => props.reviewing || (props.draft.status === 'reviewing' && mustFixCount.value === 0),
)

/** 审查等待标语（随机轮换，缓解干等） */
const { slogan: reviewSlogan } = use_rotating_slogan(reviewRunning, REVIEW_SLOGANS)
</script>

<template>
  <div class="review-panel">
    <!-- 审查进行中：随机轮换等待标语（Plan 3.5：不让用户干等） -->
    <div v-if="reviewRunning" class="review-progress">
      <div class="review-progress-head">
        <Icon icon="lucide:brain" width="15" class="spin" />
        <span>正在审查功能</span>
      </div>
      <p class="review-slogan">{{ reviewSlogan }}</p>
    </div>

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

/* ---------- 审查进行中：等待标语 ---------- */
.review-progress {
  margin-top: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: linear-gradient(180deg, var(--accent-soft) 0%, var(--surface) 70%);
  box-shadow: var(--shadow);
}

.review-progress-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--accent);
}

.review-progress-head .spin {
  animation: spin 1s linear infinite;
}

.review-slogan {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  min-height: 1.6em;
  transition: opacity 150ms ease-out;
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
