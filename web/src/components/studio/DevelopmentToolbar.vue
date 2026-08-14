<script setup>
// 顶部工具栏：返回、草稿信息、连接状态、主操作按钮（Plan 3.2）
import { Icon } from '@iconify/vue'
import { STATUS_LABELS } from '@/utils/draft_status'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

defineProps({
  draft: { type: Object, required: true },
  connected: { type: Boolean, default: false },
  opencodeAvailable: { type: Boolean, default: false },
  /** 主操作按钮（Plan 3.4）：{ label, icon, variant, handler, disabled, loading } | null */
  primaryAction: { type: Object, default: null },
})

defineEmits(['back'])

function statusVariant(status) {
  switch (status) {
    case 'planning':
    case 'coding':
      return 'accent'
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
  <header class="toolbar">
    <Button variant="ghost" icon-only title="返回草稿列表" @click="$emit('back')">
      <Icon icon="lucide:arrow-left" width="16" />
    </Button>
    <div class="draft-title">
      <span class="name">{{ draft.name }}</span>
      <span class="id mono">{{ draft.extension_id }}</span>
      <Badge :variant="statusVariant(draft.status)">{{ STATUS_LABELS[draft.status] }}</Badge>
    </div>
    <div class="toolbar-right">
      <Badge :variant="connected ? 'success' : 'warning'">
        <span class="status-dot" />
        {{ connected ? '实时连接' : '重连中' }}
      </Badge>
      <Badge :variant="opencodeAvailable ? 'success' : 'neutral'">
        <span class="status-dot" />
        OpenCode
      </Badge>
      <Button
        v-if="primaryAction"
        :variant="primaryAction.variant"
        :disabled="primaryAction.disabled"
        :loading="primaryAction.loading"
        @click="primaryAction.handler"
      >
        <Icon :icon="primaryAction.icon" width="15" />
        {{ primaryAction.label }}
      </Button>
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  height: var(--topbar-height);
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
  background: var(--surface);
}

.draft-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.draft-title .name {
  font-weight: 600;
  font-size: var(--text-base);
  letter-spacing: -0.01em;
}

.draft-title .id {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

@media (max-width: 720px) {
  .toolbar-right :deep(.ui-badge) {
    display: none;
  }
}
</style>
