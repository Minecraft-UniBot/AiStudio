<script setup>
// 检查面板（AGENT.md 3.5）：展示机械校验状态，提供「让 AI 修复校验问题」「重新校验」
// 「同步测试环境」入口。编码完成后由后端自动机械校验，不再有独立审核 AI。
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import Button from '@/components/ui/Button.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Badge from '@/components/ui/Badge.vue'

const props = defineProps({
  draft: { type: Object, required: true },
  repairing: { type: Boolean, default: false },
})

const emit = defineEmits(['fix-validation', 'check-validation', 'sync-env'])

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
/** 校验失败且存在 AI 可修复步骤 → 「让 AI 修复校验问题」 */
const canFixValidation = computed(
  () =>
    validation.value?.status === 'failed' &&
    fixableFailures.value.length > 0 &&
    props.draft.status !== 'ready' &&
    !['planning', 'coding'].includes(props.draft.status) &&
    !props.repairing,
)
/** 允许手动重新校验（非进行中且非工作状态） */
const canRecheck = computed(
  () =>
    validation.value?.status !== 'running' &&
    !['planning', 'coding'].includes(props.draft.status) &&
    !props.repairing,
)
</script>

<template>
  <div class="validation-panel">
    <!-- 机械校验结果 -->
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
      <!-- 操作区 -->
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

    <EmptyState
      v-else
      icon="lucide:shield-check"
      title="尚未检查"
      description="AI 编码结束后会自动执行机械校验；通过后方可一键发布。"
    />
  </div>
</template>

<style scoped>
.validation-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

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
</style>
