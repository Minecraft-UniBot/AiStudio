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
        <Icon icon="lucide:box" width="20" class="brand-icon" />
        <span class="title">UniBot Extension Studio</span>
        <span v-if="store.status" class="oc-status" :class="{ ok: store.opencodeAvailable }">
          <span class="dot" /> OpenCode {{ store.opencodeAvailable ? `v${store.status.version}` : '不可用' }}
        </span>
      </div>
      <div class="topbar-right">
        <RouterLink to="/admin" class="topbar-link">
          <Icon icon="lucide:settings" width="15" /> 设置
        </RouterLink>
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
          <Button v-else @click="store.fetchStatus()">
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
  height: 52px;
  padding: 0 20px;
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
  gap: 10px;
}

.brand-icon {
  color: var(--accent);
}

.title {
  font-weight: 600;
  font-size: 15px;
}

.topbar-right {
  display: flex;
  align-items: center;
}

.topbar-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 6px 10px;
  border-radius: var(--radius);
  transition: background-color var(--transition), color var(--transition);
}

.topbar-link:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.oc-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--danger);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--danger-soft);
}

.oc-status.ok {
  color: var(--success);
  background: var(--success-soft);
}

.oc-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.page-head h2 {
  margin: 0 0 4px;
  font-size: 20px;
  letter-spacing: -0.01em;
}

.page-head .sub {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

@media (max-width: 640px) {
  .oc-status {
    display: none;
  }
}
</style>
