<script setup>
// AI 开发工作台：左栏文件树 / 中栏对话 / 右栏结果与检查（Plan 3.2）
// 桌面三栏（可折叠、可拖拽），手机端单栏 Tabs
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import DevelopmentToolbar from '@/components/studio/DevelopmentToolbar.vue'
import ConversationPanel from '@/components/studio/ConversationPanel.vue'
import DraftFileTree from '@/components/studio/DraftFileTree.vue'
import ResultSummary from '@/components/studio/ResultSummary.vue'
import ValidationPanel from '@/components/studio/ValidationPanel.vue'
import PublishDialog from '@/components/studio/PublishDialog.vue'
import ResizablePanel from '@/components/ui/ResizablePanel.vue'
import Button from '@/components/ui/Button.vue'
import FileViewer from '@/components/studio/FileViewer.vue'

const route = useRoute()
const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const draftId = route.params.id
const activeTab = ref('result') // result | check | settings
const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const fileTree = ref([])
const fileSizes = ref({})
const selectedFile = ref('')
const fileContent = ref('')
const fileLoading = ref(false)
const fileViewerOpen = ref(false)
const validating = ref(false)
const reviewing = ref(false)
const repairing = ref(false)
const publishing = ref(false)
const publishOpen = ref(false)
/** 本地摘要过期标记：发送消息后置 true，校验通过后清除（Plan 12.2） */
const revisionDirty = ref(false)

const draft = computed(() => store.currentDraft)
const busy = computed(() =>
  ['generating', 'repairing', 'debugging'].includes(draft.value?.status),
)
const reviewPassed = computed(() => draft.value?.review?.status === 'passed')
const canPublish = computed(
  () =>
    draft.value?.status === 'ready' &&
    !revisionDirty.value &&
    !validating.value &&
    !reviewing.value &&
    reviewPassed.value,
)

// ===== 主操作按钮状态机（Plan 3.4） =====
const primaryAction = computed(() => {
  const status = draft.value?.status
  // 生成 / 修复 / 调试中 → 停止
  if (['generating', 'repairing', 'debugging'].includes(status)) {
    return { label: '停止生成', icon: 'lucide:square', variant: 'danger', handler: stop }
  }
  // 需要用户补充信息（Plan 3.4：显示易懂的问题）
  if (store.pendingQuestions.length > 0) {
    return { label: '需要你确认', icon: 'lucide:help-circle', variant: 'secondary', disabled: true }
  }
  // 检查中（Plan 3.4：显示当前检查项目）
  if (status === 'checking') {
    if (draft.value?.validation?.status === 'failed') {
      return { label: '自动修复', icon: 'lucide:wrench', variant: 'warning', handler: autoFix }
    }
    return { label: '检查中…', icon: 'lucide:loader-2', variant: 'secondary', disabled: true, loading: true }
  }
  // 审核中：有 must_fix → 自动修复；否则审核进行中
  if (status === 'reviewing') {
    const mustFix = draft.value?.review?.issues?.some((issue) => issue.severity === 'must_fix')
    if (mustFix) {
      return { label: '自动修复', icon: 'lucide:wrench', variant: 'warning', handler: autoFix }
    }
    return { label: '审核中…', icon: 'lucide:brain', variant: 'secondary', disabled: true, loading: true }
  }
  // 可发布
  if (status === 'ready') {
    return {
      label: publishing.value ? '发布中…' : '一键发布',
      icon: 'lucide:rocket',
      variant: 'primary',
      handler: openPublish,
      disabled: !canPublish.value,
      loading: publishing.value,
    }
  }
  return null
})

// ===== 文件树 =====
async function loadFiles() {
  const files = await store.fetchFiles(draftId)
  fileSizes.value = Object.fromEntries(files.map((file) => [file.path, file.size]))
  fileTree.value = buildTree(files.map((file) => file.path))
}

function buildTree(paths) {
  const root = []
  const map = new Map()
  for (const path of paths) {
    const parts = path.split('/')
    let level = root
    let key = ''
    for (const part of parts) {
      key = key ? `${key}/${part}` : part
      let node = map.get(key)
      if (!node) {
        node = { name: part, path: key, children: [] }
        map.set(key, node)
        level.push(node)
      }
      level = node.children
    }
  }
  return root
}

async function openFile(path) {
  selectedFile.value = path
  fileLoading.value = true
  fileContent.value = ''
  fileViewerOpen.value = true
  try {
    fileContent.value = await store.fetchFileContent(draftId, path)
  } finally {
    fileLoading.value = false
  }
}

// ===== 刷新 =====
async function refreshAll() {
  store.resetPending()
  await store.fetchDraft(draftId)
  await store.fetchMessages(draftId)
  await store.fetchDiff(draftId)
  await store.fetchTodo(draftId)
  await Promise.all([store.fetchMessages(draftId), loadFiles()])
}

watch(
  () => store.currentDraft?.value?.validation_revision,
  (revision) => {
    // 后端摘要变化（校验通过）时清除本地过期标记
    if (revision) revisionDirty.value = false
  },
)

// ===== 对话 =====
async function send(text) {
  try {
    await store.sendPrompt(draftId, text)
    // 发送后文件可能变更，锁定发布直到重新校验（Plan 12.2）
    revisionDirty.value = true
  } catch (e) {
    toast_error(e.message)
  }
}

async function stop() {
  await store.abort(draftId)
}

async function replyPermission(permission, response) {
  try {
    await store.replyPermission(draftId, permission.id, response)
    store.removePendingPermission(permission.id)
  } catch (e) {
    toast_error(e.message)
  }
}

async function replyQuestion(question, answer) {
  try {
    await store.replyQuestion(draftId, question.id, answer)
    store.removePendingQuestion(question.id)
  } catch (e) {
    toast_error(e.message)
  }
}

// ===== 校验 / 审核 / 修复 =====
async function validate() {
  validating.value = true
  try {
    await store.runValidation(draftId)
    await store.fetchDraft(draftId)
  } catch (e) {
    toast_error(e.message)
  } finally {
    validating.value = false
  }
}

async function review() {
  reviewing.value = true
  try {
    await store.startReview(draftId)
    await store.fetchDraft(draftId)
  } catch (e) {
    toast_error(e.message)
  } finally {
    reviewing.value = false
  }
}

async function autoFix() {
  repairing.value = true
  try {
    await store.startDebug(draftId)
    await store.fetchDraft(draftId)
  } catch (e) {
    toast_error(e.message)
  } finally {
    repairing.value = false
  }
}

// ===== 发布 =====
function openPublish() {
  if (!canPublish.value) return
  publishOpen.value = true
}

async function confirmPublish() {
  publishing.value = true
  try {
    await store.publish(draftId)
    publishOpen.value = false
    toast_success('发布成功！重启 UniBot 后扩展生效。')
    await store.fetchDraft(draftId)
  } catch (e) {
    toast_error(e.message)
  } finally {
    publishing.value = false
  }
}

function expandLeft() {
  leftCollapsed.value = false
}

function expandRight() {
  rightCollapsed.value = false
}

onMounted(async () => {
  await refreshAll()
})
</script>

<template>
  <div v-if="draft" class="workspace">
    <DevelopmentToolbar
      :draft="draft"
      :connected="store.connected"
      :opencode-available="store.opencodeAvailable"
      :primary-action="primaryAction"
      @back="router.push('/')"
    />

    <!-- 手机端 Tab 切换（Plan 3.2） -->
    <nav class="mobile-tabs">
      <button
        v-for="tab in [
          { id: 'result', label: '对话' },
          { id: 'check', label: '检查' },
          { id: 'settings', label: '结果与设置' },
        ]"
        :key="tab.id"
        class="mobile-tab"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="panels">
      <!-- 左栏：文件树（可拖拽/折叠） -->
      <ResizablePanel
        v-if="!leftCollapsed"
        side="left"
        :default-width="250"
        :min-width="200"
        :max-width="420"
        class="left-panel-wrap"
      >
        <DraftFileTree
          :draft="draft"
          :file-tree="fileTree"
          :selected-file="selectedFile"
          :empty-text="store.messages.length ? '生成中…' : '加载中…'"
          @select-file="openFile"
          @collapse="leftCollapsed = true"
        />
      </ResizablePanel>
      <Button v-else variant="ghost" icon-only class="expand-left" title="展开文件栏" @click="expandLeft">
        <Icon icon="lucide:panel-left-open" width="14" />
      </Button>

      <!-- 中栏：对话 -->
      <ConversationPanel
        class="center-panel"
        :draft-id="draftId"
        :messages="store.messages"
        :pending-permissions="store.pendingPermissions"
        :pending-questions="store.pendingQuestions"
        :busy="busy"
        @send="send"
        @stop="stop"
        @reply-permission="replyPermission"
        @reply-question="replyQuestion"
      />

      <!-- 右栏：结果 / 检查 / 设置（可拖拽/折叠） -->
      <ResizablePanel
        v-if="!rightCollapsed"
        side="right"
        :default-width="340"
        :min-width="260"
        :max-width="480"
        class="right-panel-wrap"
      >
        <div class="right-panel">
          <div class="panel-head">
            <div class="tabs">
              <button class="tab" :class="{ active: activeTab === 'result' }" @click="activeTab = 'result'">功能</button>
              <button class="tab" :class="{ active: activeTab === 'check' }" @click="activeTab = 'check'">
                检查
                <span v-if="draft.validation" class="tab-dot" :class="draft.validation.status" />
              </button>
              <button class="tab" :class="{ active: activeTab === 'settings' }" @click="activeTab = 'settings'">设置</button>
            </div>
            <Button variant="ghost" icon-only size="sm" title="折叠" @click="rightCollapsed = true">
              <Icon icon="lucide:panel-right-close" width="14" />
            </Button>
          </div>

          <div class="right-content">
            <!-- 功能摘要 -->
            <div v-if="activeTab === 'result'" class="right-scroll">
              <ResultSummary
                :draft="draft"
                :can-publish="canPublish"
                :publishing="publishing"
                @publish="openPublish"
              />
            </div>

            <!-- 检查 -->
            <div v-else-if="activeTab === 'check'" class="right-scroll">
              <ValidationPanel
                :draft="draft"
                :validating="validating"
                :reviewing="reviewing"
                :repairing="repairing"
                @validate="validate"
                @review="review"
                @debug="autoFix"
              />
            </div>

            <!-- 设置 -->
            <div v-else class="right-scroll">
              <div class="result-section">
                <h4>会话设置</h4>
                <dl class="info-grid">
                  <dt>Agent</dt>
                  <dd class="mono">{{ draft.agent }}</dd>
                  <dt>模型</dt>
                  <dd class="mono">{{ draft.model ? `${draft.model.provider_id}/${draft.model.model_id}` : '自动' }}</dd>
                  <dt>创建时间</dt>
                  <dd>{{ new Date(draft.created_at).toLocaleString() }}</dd>
                  <dt>最近更新</dt>
                  <dd>{{ new Date(draft.updated_at).toLocaleString() }}</dd>
                </dl>
              </div>
              <div v-if="draft.status === 'published'" class="result-section published-box">
                <Icon icon="lucide:check-circle-2" width="16" color="var(--success)" />
                <span>已发布（{{ new Date(draft.published_at).toLocaleString() }}），草稿为只读</span>
              </div>
              <div v-if="draft.status === 'failed'" class="result-section failed-box">
                <Icon icon="lucide:alert-triangle" width="16" color="var(--danger)" />
                <span>{{ draft.error || '生成失败，可在对话区补充需求后重试' }}</span>
              </div>
            </div>
          </div>
        </div>
      </ResizablePanel>
      <Button v-else variant="ghost" icon-only class="expand-right" title="展开结果栏" @click="expandRight">
        <Icon icon="lucide:panel-right-open" width="14" />
      </Button>
    </div>

    <!-- 发布确认 -->
    <PublishDialog
      v-model="publishOpen"
      :draft="draft"
      :publishing="publishing"
      @confirm="confirmPublish"
    />

    <!-- 大尺寸文件查看器 -->
    <FileViewer
      v-model="fileViewerOpen"
      :path="selectedFile"
      :content="fileContent"
      :size="fileSizes[selectedFile] ?? 0"
      :loading="fileLoading"
    />
  </div>
  <div v-else class="loading-page">加载草稿…</div>
</template>

<style scoped>
.workspace {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panels {
  flex: 1;
  display: flex;
  min-height: 0;
}

.left-panel-wrap {
  border-right: 1px solid var(--border);
}

.right-panel-wrap {
  border-left: 1px solid var(--border);
}

.right-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.panel-head {
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.tabs {
  display: flex;
  gap: 2px;
}

.tab {
  padding: 6px 10px;
  border: none;
  background: transparent;
  font-size: 12.5px;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition: color var(--transition), background-color var(--transition);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.tab-dot.passed {
  background: var(--success);
}

.tab-dot.failed {
  background: var(--danger);
}

.tab-dot.running {
  background: var(--warning);
}

.right-content {
  flex: 1;
  min-height: 0;
  display: flex;
}

.right-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 14px 16px;
}

.expand-left,
.expand-right {
  align-self: center;
  flex-shrink: 0;
}

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
  grid-template-columns: 72px 1fr;
  gap: 7px;
  margin: 0;
  font-size: 13px;
}

.info-grid dt {
  color: var(--text-muted);
}

.info-grid dd {
  margin: 0;
  word-break: break-all;
}

.published-box,
.failed-box {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* 手机端单栏（Plan 3.2） */
.mobile-tabs {
  display: none;
}

@media (max-width: 860px) {
  .mobile-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }

  .mobile-tab {
    flex: 1;
    padding: 9px 0;
    border: none;
    background: transparent;
    font-size: 13px;
    color: var(--text-muted);
    cursor: pointer;
  }

  .mobile-tab.active {
    color: var(--accent);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--accent);
  }

  .left-panel-wrap,
  .right-panel-wrap {
    display: none;
  }

  .expand-left,
  .expand-right {
    display: none;
  }
}

.loading-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13.5px;
}
</style>
