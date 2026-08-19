<script setup>
// 草稿列表页（Plan 3.1：默认展示草稿列表 + 新建扩展）
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import DraftList from '@/components/studio/DraftList.vue'
import DraftCreateDialog from '@/components/studio/DraftCreateDialog.vue'
import UnibotDirSetupDialog from '@/components/studio/UnibotDirSetupDialog.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const loading = ref(false)
const dialogOpen = ref(false)
// UniBot 目录引导：首次登录（后端尚未显式配置）时自动弹出，让用户选择 UniBot 目录
const dirSetupOpen = ref(false)

onMounted(async () => {
  loading.value = true
  try {
    await store.fetchStatus()
    await store.fetchDrafts()
    await store.fetchOptions()
    await store.fetchTemplates()
    // status 拉取后再判断：未配置则弹出引导（仅本次登录首次，用户可「稍后再说」）
    if (store.status && store.status.unibot_configured === false) {
      dirSetupOpen.value = true
    }
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

// UniBot 目录保存成功后：刷新状态（让顶部状态徽章 / 发布逻辑读到新目录）
function onUnibotDirSaved() {
  store.fetchStatus()
  toast_success('UniBot 目录已保存，发布目标已更新')
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
        <Button
          v-if="store.status && store.status.unibot_configured === false"
          variant="warning"
          size="sm"
          @click="dirSetupOpen = true"
        >
          <Icon icon="lucide:folder-input" width="15" /> 设置 UniBot 目录
        </Button>
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

      <!-- 未配置 UniBot 目录的提示条：跳过后仍可从此入口重新设置 -->
      <div
        v-if="store.status && store.status.unibot_configured === false"
        class="setup-banner"
        role="note"
      >
        <Icon icon="lucide:triangle-alert" width="16" class="banner-icon" />
        <div class="banner-body">
          <span class="banner-title">尚未设置 UniBot 目录</span>
          <span class="banner-text">
            发布扩展前需要确认 UniBot 根目录，否则无法交付到
            <code>Extensions/</code>。当前探测目录：
            <code>{{ store.status.unibot_dir || '未探测到' }}</code>
          </span>
        </div>
        <Button size="sm" variant="primary" @click="dirSetupOpen = true">
          <Icon icon="lucide:folder-input" width="14" /> 去设置
        </Button>
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
    <UnibotDirSetupDialog
      v-model:open="dirSetupOpen"
      :current-dir="store.status?.unibot_dir ?? ''"
      :onboarding="true"
      @saved="onUnibotDirSaved"
    />
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

/* 未配置 UniBot 目录提示条 */
.setup-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-5);
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  border-radius: var(--radius-md);
}

.banner-icon {
  flex-shrink: 0;
  color: var(--warning);
}

.banner-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.banner-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.banner-text {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}

.banner-text code {
  padding: 0 4px;
  background: rgb(255 255 255 / 0.7);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  word-break: break-all;
}

@media (max-width: 640px) {
  .topbar-left :deep(.ui-badge) {
    display: none;
  }
}
</style>
