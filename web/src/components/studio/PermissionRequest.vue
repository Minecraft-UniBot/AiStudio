<script setup>
// 权限请求：仅允许本次 / 本草稿始终允许（后端仍不放松边界）/ 拒绝
import { ref } from 'vue'
import { Icon } from '@iconify/vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'

const props = defineProps({
  draftId: { type: String, required: true },
  permission: { type: Object, required: true },
})

const store = useStudioStore()
const { error: toast_error } = use_toast()
const replying = ref(false)

async function reply(response) {
  replying.value = true
  try {
    await store.replyPermission(props.draftId, props.permission.id, response)
  } catch (e) {
    toast_error(e.message)
  } finally {
    replying.value = false
  }
}

function metaText() {
  const meta = props.permission.metadata ?? {}
  const cmd = meta.command ?? meta.cmd ?? ''
  const url = meta.url ?? ''
  const file = meta.file_path ?? meta.path ?? ''
  if (cmd) return { icon: 'lucide:terminal', text: cmd }
  if (url) return { icon: 'lucide:globe', text: url }
  if (file) return { icon: 'lucide:file', text: file }
  return { icon: 'lucide:shield-alert', text: props.permission.permission }
}
</script>

<template>
  <div class="permission-card">
    <div class="perm-head">
      <div class="perm-icon-wrap">
        <Icon icon="lucide:shield-alert" width="15" class="perm-icon" />
      </div>
      <span class="perm-title">需要授权</span>
      <Badge variant="warning" class="perm-tool">{{ permission.tool_name || permission.permission }}</Badge>
    </div>
    <div class="perm-meta">
      <Icon :icon="metaText().icon" width="13" class="perm-meta-icon" />
      <code class="perm-meta-text">{{ metaText().text }}</code>
    </div>
    <p class="perm-desc">{{ permission.description }}</p>
    <div class="perm-actions">
      <Button size="sm" variant="secondary" :disabled="replying" @click="reply('once')">仅允许本次</Button>
      <Button size="sm" variant="primary" :disabled="replying" @click="reply('always')">本草稿始终允许</Button>
      <Button size="sm" variant="danger" :disabled="replying" @click="reply('reject')">拒绝</Button>
    </div>
  </div>
</template>

<style scoped>
.permission-card {
  border: 1px solid #fde68a;
  background: #fffaeb;
  border-radius: var(--radius-md);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  box-shadow: var(--shadow);
}

.perm-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.perm-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius);
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  flex-shrink: 0;
}

.perm-icon {
  color: var(--warning);
}

.perm-title {
  font-weight: 600;
  color: var(--text);
}

.perm-tool {
  margin-left: auto;
}

.perm-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  overflow: hidden;
}

.perm-meta-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.perm-meta-text {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perm-desc {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}

.perm-actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
</style>
