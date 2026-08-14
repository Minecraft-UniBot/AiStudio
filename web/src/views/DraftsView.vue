<script setup>
// 草稿列表页（Plan 3.1：默认展示草稿列表 + 新建扩展）
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import DraftList from '@/components/studio/DraftList.vue'
import DraftCreateDialog from '@/components/studio/DraftCreateDialog.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const loading = ref(false)
const dialogOpen = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    await store.fetchStatus()
    await store.fetchDrafts()
    await store.fetchOptions()
  } finally {
    loading.value = false
  }
})

function openDraft(draft) {
  router.push(`/workspace/${draft.id}`)
}

async function removeDraft(draft) {
  if (draft.status === 'published') return
  // 删除确认改用 toast 交互：先提示，用户在卡片上再次点击删除（由组件触发两次）
  if (!confirm(`删除草稿「${draft.name}」？此操作不可恢复。`)) return
  try {
    await store.removeDraft(draft.id)
    toast_success(`草稿「${draft.name}」已删除`)
  } catch (e) {
    toast_error(e.message)
  }
}
</script>

<template>
  <div class="drafts-page">
    <header class="topbar">
      <div class="topbar-left">
        <div class="brand-icon">
          <Icon icon="lucide:box" width="18" />
        </div>
        <span class="title">UniBot Extension Studio</span>
        <Badge v-if="store.status" :variant="store.opencodeAvailable ? 'success' : 'danger'">
          <span class="status-dot" />
          OpenCode {{ store.opencodeAvailable ? `v${store.status.version}` : '不可用' }}
        </Badge>
      </div>
      <div class="topbar-right">
        <Button variant="ghost" size="sm" @click="router.push('/admin')">
          <Icon icon="lucide:settings" width="15" /> 设置
        </Button>
      </div>
    </header>

    <main class="content">
      <div class="page-head">
        <div>
          <h2>扩展草稿</h2>
          <p class="sub">草稿保存在平台数据目录，发布后才会交付到 UniBot</p>
        </div>
        <div class="page-head-actions">
          <Button v-if="store.opencodeAvailable" variant="primary" @click="dialogOpen = true">
            <Icon icon="lucide:plus" width="16" /> 新建扩展
          </Button>
          <Button v-else variant="secondary" @click="store.fetchStatus()">
            <Icon icon="lucide:refresh-cw" width="15" /> 刷新状态
          </Button>
        </div>
      </div>

      <DraftList
        :drafts="store.drafts"
        :loading="loading"
        :opencode-available="store.opencodeAvailable"
        :oc-error="store.status?.error ?? ''"
        @open="openDraft"
        @remove="removeDraft"
      />
    </main>

    <DraftCreateDialog v-model="dialogOpen" />
  </div>
</template>

<style scoped>
.drafts-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: var(--topbar-height);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  background: var(--surface);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.brand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
}

.title {
  font-weight: 600;
  font-size: var(--text-md);
  letter-spacing: -0.01em;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.topbar-right {
  display: flex;
  align-items: center;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-6);
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.page-head h2 {
  margin: 0 0 var(--space-1);
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: -0.01em;
}

.page-head .sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

@media (max-width: 640px) {
  .topbar-left :deep(.ui-badge) {
    display: none;
  }
}
</style>
