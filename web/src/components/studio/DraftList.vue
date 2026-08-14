<script setup>
// 草稿列表（Plan 3.1：默认展示草稿列表）
import { Icon } from '@iconify/vue'
import { STATUS_LABELS, TYPE_LABELS } from '@/utils/draft_status'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import Spinner from '@/components/ui/Spinner.vue'

defineProps({
  drafts: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  opencodeAvailable: { type: Boolean, default: false },
  ocError: { type: String, default: '' },
})

const emit = defineEmits(['open', 'remove', 'create', 'refresh-status'])

function statusVariant(status) {
  switch (status) {
    case 'generating':
      return 'accent'
    case 'checking':
    case 'repairing':
      return 'warning'
    case 'reviewing':
    case 'debugging':
      return 'accent'
    case 'ready':
    case 'published':
      return 'success'
    case 'failed':
    case 'error':
      return 'danger'
    default:
      return 'neutral'
  }
}
</script>

<template>
  <div class="draft-list">
    <p v-if="!opencodeAvailable" class="oc-unavailable">
      <Icon icon="lucide:alert-triangle" width="15" />
      OpenCode 服务不可用：{{ ocError || '未知原因' }}。请检查后端日志。
    </p>

    <div v-if="loading" class="loading-block">
      <Spinner :size="16" />
      <span>加载中…</span>
    </div>
    <EmptyState
      v-else-if="drafts.length === 0"
      icon="lucide:inbox"
      title="还没有草稿"
      description="点击「新建扩展」开始你的第一个扩展"
    />
    <div v-else class="draft-grid">
      <div v-for="draft in drafts" :key="draft.id" class="draft-card">
        <div class="draft-card-head">
          <span class="draft-name">{{ draft.name }}</span>
          <Badge :variant="statusVariant(draft.status)">{{ STATUS_LABELS[draft.status] }}</Badge>
        </div>
        <div class="draft-id mono">{{ draft.extension_id }}</div>
        <p class="draft-desc">{{ draft.description }}</p>
        <div class="draft-types">
          <Badge v-for="type in draft.types" :key="type" variant="accent">{{ TYPE_LABELS[type] }}</Badge>
          <Badge v-if="draft.model" variant="neutral">{{ draft.model.model_id }}</Badge>
        </div>
        <div class="draft-card-foot">
          <span class="time">{{ new Date(draft.updated_at).toLocaleString() }}</span>
          <div class="actions">
            <Button size="sm" variant="primary" @click="emit('open', draft)">
              {{ draft.status === 'published' ? '查看' : '继续开发' }}
            </Button>
            <Button
              v-if="draft.status !== 'published'"
              variant="ghost"
              icon-only
              size="sm"
              title="删除草稿"
              @click="emit('remove', draft)"
            >
              <Icon icon="lucide:trash-2" width="14" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.draft-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.oc-unavailable {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  border-radius: var(--radius-md);
  color: var(--warning);
  font-size: var(--text-sm);
}

.loading-block {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.draft-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-4);
}

.draft-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  background: var(--surface);
  box-shadow: var(--shadow);
  transition:
    border-color var(--transition),
    box-shadow var(--transition),
    transform var(--transition);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.draft-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.draft-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.draft-name {
  font-weight: 600;
  font-size: var(--text-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.draft-id {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.draft-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.draft-types {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.draft-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: auto;
  padding-top: var(--space-1);
}

.time {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.actions {
  display: flex;
  gap: var(--space-1);
}
</style>
