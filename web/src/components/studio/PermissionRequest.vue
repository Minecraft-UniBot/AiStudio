<script setup>
// 权限请求：仅允许本次 / 本草稿始终允许（后端仍不放松边界）/ 拒绝
import { ref } from 'vue'
import { Icon } from '@iconify/vue'
import Button from '@/components/ui/Button.vue'
import { useStudioStore } from '@/stores/studio'

const props = defineProps({
  draftId: { type: String, required: true },
  permission: { type: Object, required: true },
})

const store = useStudioStore()
const replying = ref(false)

async function reply(response) {
  replying.value = true
  try {
    await store.replyPermission(props.draftId, props.permission.id, response)
  } catch (e) {
    alert(e.message)
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
      <Icon icon="lucide:shield-alert" width="15" class="perm-icon" />
      <span class="perm-title">需要授权</span>
      <span class="perm-tool mono">{{ permission.tool_name || permission.permission }}</span>
    </div>
    <div class="perm-meta mono">
      <Icon :icon="metaText().icon" width="13" />
      <code>{{ metaText().text }}</code>
    </div>
    <p class="perm-desc">{{ permission.description }}</p>
    <div class="perm-actions">
      <Button size="sm" :disabled="replying" @click="reply('once')">仅允许本次</Button>
      <Button size="sm" :disabled="replying" @click="reply('always')">本草稿始终允许</Button>
      <Button variant="danger" size="sm" :disabled="replying" @click="reply('reject')">拒绝</Button>
    </div>
  </div>
</template>

<style scoped>
.permission-card {
  border: 1px solid #fde68a;
  background: #fffaeb;
  border-radius: var(--radius);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.perm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.perm-icon {
  color: var(--warning);
}

.perm-title {
  font-weight: 600;
}

.perm-tool {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-secondary);
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: 4px;
}

.perm-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
}

.perm-meta code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perm-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.perm-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
