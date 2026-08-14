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
import Dialog from '@/components/ui/Dialog.vue'
import ResizablePanel from '@/components/ui/ResizablePanel.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import Spinner from '@/components/ui/Spinner.vue'
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
/** 回退确认对话框状态 */
const reverting = ref(false)
const revertTarget = ref('')
const revertOpen = ref(false)
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
  // store.currentDraft 已被 Pinia 自动解包为草稿对象，不能访问 .value
  () => store.currentDraft?.validation_revision,
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

async function replyQuestion(question, answers) {
  try {
    await store.replyQuestion(draftId, question.id, answers)
    store.removePendingQuestion(question.id)
  } catch (e) {
    toast_error(e.message)
  }
}

async function rejectQuestion(question) {
  try {
    await store.rejectQuestion(draftId, question.id)
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

// ===== 回退到某条消息之前（Plan 3.3：恢复文件状态与对话记录） =====
function requestRevert(messageId) {
  revertTarget.value = messageId
  revertOpen.value = true
}

async function confirmRevert() {
  if (!revertTarget.value) return
  reverting.value = true
  try {
    await store.revertToMessage(draftId, revertTarget.value)
    revertOpen.value = false
    toast_success('已回退到该消息之前，文件与对话记录已恢复')
    revisionDirty.value = true
    // 刷新草稿、消息、文件、diff、待办
    await Promise.all([
      store.fetchDraft(draftId),
      store.fetchMessages(draftId),
      store.fetchDiff(draftId),
      store.fetchTodo(draftId),
    ])
    await loadFiles()
  } catch (e) {
    toast_error(e.message)
  } finally {
    reverting.value = false
  }
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
        @reject-question="rejectQuestion"
        @revert-message="requestRevert"
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
              <div v-if="draft.status === 'published'" class="result-section status-box success">
                <Icon icon="lucide:check-circle-2" width="16" />
                <span>已发布（{{ new Date(draft.published_at).toLocaleString() }}），草稿为只读</span>
              </div>
              <div v-if="draft.status === 'failed'" class="result-section status-box danger">
                <Icon icon="lucide:alert-triangle" width="16" />
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

    <!-- 回退确认：恢复文件状态和对话记录到该消息之前 -->
    <Dialog
      v-model="revertOpen"
      title="回退到该消息之前？"
      description="将撤销这条消息及其后的所有改动，恢复文件状态和对话记录；旧校验与审核结果会失效，需要重新生成与检查。"
      confirm-text="确认回退"
      confirm-variant="danger"
      :loading="reverting"
      @confirm="confirmRevert"
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
  <div v-else class="loading-page">
    <Spinner :size="18" />
    <span>加载草稿…</span>
  </div>
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
  height: 40px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
  background: var(--surface);
}

.tabs {
  display: flex;
  gap: 2px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: none;
  background: transparent;
  font-size: var(--text-sm);
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius);
  transition:
    color var(--transition),
    background-color var(--transition);
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
  padding: var(--space-1) var(--space-4) var(--space-4);
}

.expand-left,
.expand-right {
  align-self: center;
  flex-shrink: 0;
  margin: 0 var(--space-2);
}

.result-section {
  border-bottom: 1px solid var(--border);
  padding: var(--space-4) 0;
}

.result-section:first-child {
  padding-top: 0;
}

.result-section h4 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.info-grid {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--text-sm);
}

.info-grid dt {
  color: var(--text-muted);
}

.info-grid dd {
  margin: 0;
  word-break: break-all;
}

.status-box {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  border: 1px solid;
  font-weight: 500;
}

.status-box.success {
  color: var(--success);
  background: var(--success-soft);
  border-color: #bbf7d0;
}

.status-box.danger {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: #fecaca;
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
    padding: var(--space-3) 0;
    border: none;
    background: transparent;
    font-size: var(--text-sm);
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--transition);
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
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}
</style>
