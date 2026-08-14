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
      <span class="conn" :class="{ on: connected }">
        <span class="dot" /> {{ connected ? '实时连接' : '重连中' }}
      </span>
      <span class="conn" :class="{ on: opencodeAvailable }">
        <span class="dot" /> OpenCode
      </span>
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
  height: 50px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  background: var(--surface);
}

.draft-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.draft-title .name {
  font-weight: 600;
  font-size: 14.5px;
}

.draft-title .id {
  color: var(--text-secondary);
  font-size: 12px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.conn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
}

.conn.on {
  color: var(--success);
}

.conn .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.conn.on .dot {
  background: var(--success);
}

@media (max-width: 720px) {
  .conn {
    display: none;
  }
}
</style>
