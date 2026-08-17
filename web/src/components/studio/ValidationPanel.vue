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

const emit = defineEmits(['review', 'debug', 'fix-validation', 'check-validation', 'sync-env'])

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
 * 审查通过（无 must_fix）后仍有建议问题 → 显示「让 AI 修复建议」。
 * 不限于 ready：审查通过但机械校验失败回到 draft（draft.error）时同样要能修建议，
 * 否则校验失败会成为无操作入口的死胡同。
 */
const canFixSuggestions = computed(
  () =>
    suggestionCount.value > 0 &&
    !['planning', 'coding', 'debugging', 'reviewing'].includes(props.draft.status) &&
    !props.reviewing &&
    !props.repairing,
)
/** 非忙碌阶段 → 允许手动重新审查 */
const canReview = computed(
  () =>
    !['planning', 'coding', 'debugging', 'reviewing'].includes(props.draft.status) &&
    !props.repairing,
)

// ---- 机械校验结果与修复入口（校验失败不再是「没条件修、没提醒」的死胡同） ----
const validation = computed(() => props.draft.validation)
/** 校验失败步骤（含环境类，用于展示） */
const failedSteps = computed(() =>
  (validation.value?.steps ?? []).filter((step) => step.status === 'failed'),
)
/** AI 可修复的失败步骤（环境/中断类除外：不是代码问题，AI 修不了） */
const fixableFailures = computed(() =>
  failedSteps.value.filter((step) => step.id !== 'env' && step.id !== 'interrupted'),
)
/** 校验失败但仅剩环境未就绪 → 引导「同步测试环境」，不提供 AI 修复 */
const envOnlyFailure = computed(
  () =>
    validation.value?.status === 'failed' &&
    fixableFailures.value.length === 0 &&
    failedSteps.value.some((step) => step.id === 'env'),
)
/** 校验失败且存在 AI 可修复步骤 → 「让 AI 修复校验问题」（失败详情作为问题单喂给 AI） */
const canFixValidation = computed(
  () =>
    validation.value?.status === 'failed' &&
    fixableFailures.value.length > 0 &&
    !['planning', 'coding', 'debugging', 'reviewing'].includes(props.draft.status) &&
    !props.reviewing &&
    !props.repairing,
)
/** 审查已通过但尚未 ready（校验失败/未跑完/测试环境恢复后）→ 允许手动重新校验 */
const canRecheck = computed(
  () =>
    props.draft.review?.status === 'passed' &&
    props.draft.status !== 'ready' &&
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

    <!-- 机械校验结果：失败步骤可见 + 修复/重跑入口（校验失败不再无提示、无入口） -->
    <div v-if="validation" class="validation-result" :class="validation.status">
      <div class="validation-head">
        <Icon
          :icon="validation.status === 'passed' ? 'lucide:check-circle-2' : validation.status === 'failed' ? 'lucide:alert-triangle' : 'lucide:loader-2'"
          width="14"
          :class="{ spin: validation.status === 'running' }"
        />
        <span>
          {{
            validation.status === 'passed'
              ? '机械校验通过'
              : validation.status === 'failed'
                ? '机械校验未通过'
                : '机械校验进行中…（若长时间未完成，可点「重新校验」重跑）'
          }}
        </span>
      </div>
      <ul v-if="failedSteps.length" class="validation-fails">
        <li v-for="step in failedSteps" :key="step.id" class="vf-item">
          <span class="vf-name">{{ step.name }}</span>
          <p v-if="step.message" class="vf-msg">{{ step.message }}</p>
          <pre v-if="step.detail" class="vf-detail">{{ step.detail }}</pre>
        </li>
      </ul>
      <!-- 操作区：failed 提供修复/同步/重跑；running 可能是陈旧记录（旧版抛错遗留），同样提供重跑 -->
      <div v-if="validation.status !== 'passed'" class="validation-actions">
        <Button
          v-if="canFixValidation"
          size="sm"
          variant="warning"
          :loading="repairing"
          @click="emit('fix-validation')"
        >
          <Icon icon="lucide:wrench" width="14" :class="{ spin: repairing }" />
          {{ repairing ? '修复中…' : `让 AI 修复校验问题（${fixableFailures.length}）` }}
        </Button>
        <Button v-if="envOnlyFailure" size="sm" variant="secondary" @click="emit('sync-env')">
          <Icon icon="lucide:refresh-cw" width="14" />
          同步测试环境
        </Button>
        <Button v-if="canRecheck" size="sm" variant="secondary" @click="emit('check-validation')">
          <Icon icon="lucide:rotate-cw" width="14" />
          重新校验
        </Button>
      </div>
      <p v-if="envOnlyFailure" class="validation-hint">
        测试环境未就绪不是代码问题，AI 无法修复；请先「同步测试环境」，完成后点「重新校验」。
      </p>
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

/* ---------- 机械校验结果 ---------- */
.validation-result {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  background: var(--surface);
}

.validation-result.failed {
  border-color: #fecaca;
  background: var(--danger-soft);
}

.validation-result.passed {
  border-color: #bbf7d0;
  background: var(--success-soft);
}

.validation-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.validation-result.failed .validation-head {
  color: var(--danger);
}

.validation-result.passed .validation-head {
  color: var(--success);
}

.validation-fails {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.vf-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--space-2) var(--space-3);
}

.vf-name {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text);
}

.vf-msg {
  margin: 2px 0 0;
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--text-secondary);
  word-break: break-word;
}

.vf-detail {
  margin: var(--space-1) 0 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-muted);
  font-family: var(--font-mono);
  max-height: 120px;
  overflow-y: auto;
}

.validation-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}

.validation-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  line-height: 1.5;
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
