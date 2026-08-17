<script setup>
// 功能结果摘要（Plan 3.4 右栏「功能」Tab）：扩展信息 + 机械校验状态 + 发布入口
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { TYPE_LABELS } from '@/utils/draft_status'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const props = defineProps({
  draft: { type: Object, required: true },
  canPublish: { type: Boolean, default: false },
  publishing: { type: Boolean, default: false },
})

const emit = defineEmits(['publish'])

const canPublishHint = computed(() => {
  const status = props.draft.status
  if (status === 'published') return '已发布，草稿为只读'
  // 编码完成但机械校验失败退回 draft：提示真实原因（顶部错误横幅有详情）
  if (props.draft.error) return '机械校验未通过，暂时无法发布（见顶部错误提示）'
  if (status !== 'ready') return '编码完成且机械校验通过后即可发布'
  return ''
})
</script>

<template>
  <div class="result-summary">
    <div class="result-section">
      <h4>扩展信息</h4>
      <dl class="info-grid">
        <dt>扩展 ID</dt>
        <dd class="mono">{{ draft.extension_id }}</dd>
        <dt>显示名称</dt>
        <dd>{{ draft.name }}</dd>
        <dt>描述</dt>
        <dd>{{ draft.description }}</dd>
        <dt>类型</dt>
        <dd>{{ draft.types.map((type) => TYPE_LABELS[type]).join('、') }}</dd>
      </dl>
    </div>

    <!-- 空气状态：编码中 / 校验中（由后端自动触发机械校验） -->
    <div v-if="['planning', 'coding'].includes(draft.status)" class="result-section status-box working">
      <Icon icon="lucide:loader-2" width="16" class="spin" />
      <span>{{ draft.status === 'coding' ? '编码与机械校验进行中…' : 'AI 正在规划实现方案…' }}</span>
    </div>
    <div v-else-if="draft.validation" class="result-section status-box" :class="draft.validation.status">
      <Icon
        :icon="draft.validation.status === 'passed' ? 'lucide:check-circle-2' : draft.validation.status === 'failed' ? 'lucide:alert-triangle' : 'lucide:loader-2'"
        width="16"
        :class="{ spin: draft.validation.status === 'running' }"
      />
      <span>
        {{ draft.validation.status === 'passed' ? '机械校验通过，可以发布' : draft.validation.status === 'failed' ? '机械校验未通过' : '机械校验进行中…' }}
      </span>
    </div>

    <div class="result-section">
      <h4>发布</h4>
      <Button
        variant="primary"
        class="publish-btn"
        :disabled="!canPublish || publishing"
        :loading="publishing"
        @click="emit('publish')"
      >
        <Icon icon="lucide:rocket" width="15" />
        {{ publishing ? '发布中…' : '一键发布到 UniBot' }}
      </Button>
      <p class="publish-hint">
        <Icon icon="lucide:info" width="13" />
        {{ canPublishHint || '发布采用原子交付；目标 ID 已存在时拒绝覆盖。' }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.result-section {
  border-bottom: 1px solid var(--border);
  padding: var(--space-4) 0;
}

.result-section:first-child {
  padding-top: 0;
}

.result-section h4 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.info-grid {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
}

.info-grid dt {
  color: var(--text-muted);
}

.info-grid dd {
  margin: 0;
  word-break: break-word;
  line-height: 1.5;
}

.status-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  border: 1px solid;
  font-weight: 500;
}

.status-box.passed {
  color: var(--success);
  background: var(--success-soft);
  border-color: #bbf7d0;
}

.status-box.failed {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: #fecaca;
}

.status-box.working {
  color: var(--text-secondary);
  background: var(--surface-sunken);
  border-color: var(--border);
}

.status-box.running {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: #bfdbfe;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.publish-btn {
  width: 100%;
  justify-content: center;
}

.publish-hint {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.publish-hint svg {
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
