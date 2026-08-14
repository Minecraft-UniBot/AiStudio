<script setup>
// 功能结果摘要（Plan 3.4 右栏「功能」Tab）：扩展信息 + AI 审核 + 发布入口
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { TYPE_LABELS } from '@/utils/draft_status'
import AiReviewPanel from './AiReviewPanel.vue'
import Button from '@/components/ui/Button.vue'

const props = defineProps({
  draft: { type: Object, required: true },
  canPublish: { type: Boolean, default: false },
  publishing: { type: Boolean, default: false },
})

const emit = defineEmits(['publish'])

const canPublishHint = computed(() => {
  const status = props.draft.status
  if (status === 'published') return '已发布，草稿为只读'
  if (status !== 'ready') return '校验与审核通过后即可发布'
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

    <AiReviewPanel :review="draft.review" />

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
  padding: 14px 0;
}

.result-section:first-child {
  padding-top: 0;
}

.result-section h4 {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-secondary);
}

.info-grid {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 7px;
  margin: 0;
  font-size: 13px;
}

.info-grid dt {
  color: var(--text-muted);
}

.info-grid dd {
  margin: 0;
  word-break: break-word;
  line-height: 1.5;
}

.publish-btn {
  width: 100%;
  justify-content: center;
}

.publish-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.publish-hint svg {
  flex-shrink: 0;
}
</style>
