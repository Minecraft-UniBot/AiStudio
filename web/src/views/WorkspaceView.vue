<script setup>
// AI 开发工作台：左栏文件树 / 中栏对话 / 右栏结果与检查（Plan 3.2）
// 桌面三栏（可折叠、可拖拽），手机端单栏 Tabs
import { onMounted, onUnmounted, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import { format_relative_time } from '@/utils/format'
import DevelopmentToolbar from '@/components/studio/DevelopmentToolbar.vue'
import ConversationPanel from '@/components/studio/ConversationPanel.vue'
import DraftFileTree from '@/components/studio/DraftFileTree.vue'
import ResultSummary from '@/components/studio/ResultSummary.vue'
import ValidationPanel from '@/components/studio/ValidationPanel.vue'
import PublishDialog from '@/components/studio/PublishDialog.vue'
import MarketDialog from '@/components/studio/MarketDialog.vue'
import Dialog from '@/components/ui/Dialog.vue'
import ResizablePanel from '@/components/ui/ResizablePanel.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'
import Select from '@/components/ui/Select.vue'
import Spinner from '@/components/ui/Spinner.vue'
import FileViewer from '@/components/studio/FileViewer.vue'
import TemplatePreview from '@/components/studio/TemplatePreview.vue'

const route = useRoute()
const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const draftId = route.params.id
const activeTab = ref('result') // result | preview | check | settings
const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const fileTree = ref([])
const fileSizes = ref({})
const selectedFile = ref('')
const fileContent = ref('')
const fileLoading = ref(false)
const fileViewerOpen = ref(false)
const repairing = ref(false)
const publishing = ref(false)
const publishOpen = ref(false)
/** 上传插件市场对话框状态 */
const marketOpen = ref(false)
/** 回退确认对话框状态 */
const reverting = ref(false)
const revertTarget = ref('')
const revertOpen = ref(false)
/** 本地摘要过期标记：发送消息后置 true，校验通过后清除 */
const revisionDirty = ref(false)

// ===== 开发途中切换模型（每个草稿仅一次） =====
const modelOpen = ref(false)
const switching = ref(false)
const modelForm = ref({ provider_id: '', model_id: '' })

const currentModelLabel = computed(() =>
  draft.value?.model
    ? `${draft.value.model.provider_id}/${draft.value.model.model_id}`
    : '自动',
)
const canSwitchModel = computed(
  () => !draft.value?.model_switched && draft.value?.status !== 'published',
)

const providerOptions = computed(() =>
  store.options.providers.map((p) => ({ value: p.provider_id, label: p.label })),
)
const modelOptions = computed(() => {
  const provider = store.options.providers.find(
    (p) => p.provider_id === modelForm.value.provider_id,
  )
  return (provider?.models ?? []).map((m) => ({ value: m.id, label: m.label }))
})

async function openModelSwitch() {
  // 模型列表按需拉取（工作台默认不加载 options），失败时对话框里展示错误提示
  if (!store.options.providers.length) await store.fetchOptions()
  modelForm.value = {
    provider_id: draft.value?.model?.provider_id ?? '',
    model_id: draft.value?.model?.model_id ?? '',
  }
  modelOpen.value = true
}

async function confirmSwitch() {
  switching.value = true
  try {
    const { provider_id, model_id } = modelForm.value
    await store.switchModel(
      draftId,
      provider_id && model_id ? { provider_id, model_id } : null,
    )
    modelOpen.value = false
    toast_success('模型已切换，从下一次对话开始生效')
  } catch (e) {
    toast_error(e.message)
  } finally {
    switching.value = false
  }
}

const draft = computed(() => store.currentDraft)
const busy = computed(() =>
  ['planning', 'coding'].includes(draft.value?.status),
)
const canPublish = computed(
  () =>
    draft.value?.status === 'ready' &&
    !revisionDirty.value,
)
/** 是否为渲染包（模板）扩展：有 Templates 目录才显示预览 Tab + 预览图标
 * 代码扩展（command/api）没有 Templates 目录，不显示预览 Tab */
const draftHasTemplates = computed(
  () =>
    Array.isArray(store.files) &&
    store.files.some((f) => f.path.startsWith('Templates/')),
)

/** 手机端单栏 Tabs：无模板的代码扩展不出现「预览」 */
const mobile_tabs = computed(() => {
  const tabs = [
    { id: 'result', label: '对话' },
    { id: 'check', label: '检查' },
    { id: 'settings', label: '结果与设置' },
  ]
  if (draftHasTemplates.value) {
    tabs.splice(1, 0, { id: 'preview', label: '预览' })
  }
  return tabs
})

// 预览不可用时（如代码扩展 / Templates 目录被删），退回「功能」Tab
watch(
  draftHasTemplates,
  (has_templates) => {
    if (!has_templates && activeTab.value === 'preview') {
      activeTab.value = 'result'
    }
  },
  { immediate: true },
)

// ===== 主操作按钮状态机（规划 → 编码 → 校验后发布） =====
const primaryAction = computed(() => {
  const status = draft.value?.status
  // 规划 / 编码中 → 停止
  if (['planning', 'coding'].includes(status)) {
    return { label: '停止生成', icon: 'lucide:square', variant: 'danger', handler: stop }
  }
  // 需要用户补充信息（规划阶段提问）
  if (store.pendingQuestions.length > 0) {
    return { label: '需要你确认', icon: 'lucide:help-circle', variant: 'secondary', disabled: true }
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
// store.files 由实时事件 / 刷新动作驱动更新（见 use_studio_events.js），
// 这里做响应式映射，保证文件树随后端文件变化实时刷新
watch(
  () => store.files,
  (files) => {
    fileSizes.value = Object.fromEntries(files.map((file) => [file.path, file.size]))
    fileTree.value = buildTree(files.map((file) => file.path))
  },
)

async function loadFiles() {
  await store.fetchFiles(draftId)
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
  // 兜底补推 pending 权限（SSE 事件丢失时也能弹出权限窗口）
  await store.fetchPendingPermissions(draftId)
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
    // 发送后文件可能变更，锁定发布直到重新校验
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

// ===== 校验 / 修复 =====
/** 让 AI 修复机械校验失败项（后端把失败步骤作为问题单喂给 AI 编码会话） */
async function fixValidation() {
  repairing.value = true
  try {
    await store.debugValidation(draftId)
    await store.fetchDraft(draftId)
  } catch (e) {
    toast_error(e.message)
  } finally {
    repairing.value = false
  }
}

/** 手动重新执行机械校验（校验失败修复后 / 测试环境恢复后的重跑入口） */
async function checkValidation() {
  try {
    await store.checkValidation(draftId)
    await store.fetchDraft(draftId)
    toast_success('机械校验完成')
  } catch (e) {
    toast_error(e.message)
  }
}

/** 触发后台同步 UniBot 测试环境（异步完成，完成后推送 unibot-env.updated） */
async function syncEnv() {
  try {
    await store.syncUnibotEnv()
    toast_success('已开始同步 UniBot 测试环境，完成后可重新校验')
  } catch (e) {
    toast_error(e.message)
  }
}

// ===== 发布 =====
/** 是否为覆盖发布模式（目标目录已存在同 ID 扩展） */
const publishIsUpdate = ref(false)
/** 发布确认时展示的版本号 */
const publishVersion = ref(null)

async function openPublish() {
  if (!canPublish.value) return
  publishIsUpdate.value = false
  // 加载当前版本号供发布确认弹窗展示
  try { publishVersion.value = await store.fetchVersion(draftId) } catch { publishVersion.value = null }
  publishOpen.value = true
}

/** 打开上传插件市场对话框（登录态检测 + 步骤进度，见 MarketDialog） */
function openMarket() {
  if (!canPublish.value) return
  marketOpen.value = true
}

async function confirmPublish() {
  publishing.value = true
  try {
    await store.publish(draftId, publishIsUpdate.value)
    publishOpen.value = false
    publishIsUpdate.value = false
    toast_success(publishIsUpdate.value ? '覆盖发布成功！重启 UniBot 后扩展生效。' : '发布成功！重启 UniBot 后扩展生效。')
    await store.fetchDraft(draftId)
  } catch (e) {
    // 目标已存在 → 切换到覆盖发布模式，让用户确认
    if (e.message?.includes('已存在') || e.message?.includes('使用「更新发布」')) {
      publishIsUpdate.value = true
      toast_error('目标扩展已存在，已切换到覆盖发布模式，请再次确认')
      return
    }
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

// ===== 编码/校验中轮询 =====
// 编码完成后的自动机械校验依赖 SSE 事件；若 WebSocket 短暂断开或事件丢失，
// UI 可能一直显示「编码中」。工作期间定期拉取草稿状态兜底。
const POLL_MS = 8000
let work_poll = null

watch(
  () => draft.value?.status,
  (status) => {
    if (['planning', 'coding'].includes(status) && !work_poll) {
      work_poll = setInterval(() => {
        store.fetchDraft(draftId).catch(() => {})
      }, POLL_MS)
    } else if (!['planning', 'coding'].includes(status) && work_poll) {
      clearInterval(work_poll)
      work_poll = null
    }
  },
)

onUnmounted(() => {
  if (work_poll) {
    clearInterval(work_poll)
    work_poll = null
  }
})
</script>

<template>
  <div v-if="draft" class="workspace">
    <DevelopmentToolbar
      :draft="draft"
      :connected="store.connected"
      :primary-action="primaryAction"
      @back="router.push('/')"
    />

    <!-- 后端错误横幅（校验失败 / 会话错误 / 熔断等）：任何状态都展示，
         避免「编码完成但机械校验失败」这类状态退回 draft 后错误不可见、没有操作入口 -->
    <div v-if="draft.error" class="workspace-banner danger">
      <Icon icon="lucide:alert-triangle" width="14" />
      <span>{{ draft.error }}</span>
    </div>

    <!-- 模型自动重试横幅：上游模型流式失败时 opencode 会退避重试，
         明确提示「正在重试」而不是让界面静默卡住（输出停止排查的可见性修复） -->
    <div v-if="store.sessionRetry" class="workspace-banner warning">
      <Icon icon="lucide:refresh-cw" width="14" class="spin" />
      <span>
        模型请求失败，正在自动重试<template v-if="store.sessionRetry.attempt">（第 {{ store.sessionRetry.attempt }} 次）</template>…
        <template v-if="store.sessionRetry.message">{{ store.sessionRetry.message }}</template>
        如持续失败，可停止生成后换一个模型重试。
      </span>
    </div>

    <!-- 手机端 Tab 切换（Plan 3.2） -->
    <nav class="mobile-tabs">
      <button
        v-for="tab in mobile_tabs"
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
          :empty-text="store.messages.length ? '工作中…' : '加载中…'"
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
              <button v-if="draftHasTemplates" class="tab" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'">
                预览
                <Icon icon="lucide:layout-template" width="12" />
              </button>
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
                @market="openMarket"
              />
            </div>

            <!-- 模板预览：渲染包/模板扩展的 iframe 实时预览 -->
            <div v-else-if="activeTab === 'preview'" class="preview-holder">
              <TemplatePreview :draft-id="draftId" />
            </div>

            <!-- 检查：机械校验状态 + 重新校验 / 让 AI 修复 / 同步环境 -->
            <div v-else-if="activeTab === 'check'" class="right-scroll">
              <ValidationPanel
                :draft="draft"
                :repairing="repairing"
                @fix-validation="fixValidation"
                @check-validation="checkValidation"
                @sync-env="syncEnv"
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
                  <dd>
                    <div class="model-row">
                      <span class="mono">{{ currentModelLabel }}</span>
                      <button
                        v-if="canSwitchModel"
                        type="button"
                        class="link"
                        :disabled="busy"
                        title="开发途中可切换一次模型"
                        @click="openModelSwitch"
                      >
                        切换
                      </button>
                    </div>
                    <span class="model-hint">
                      {{
                        draft.model_switched
                          ? '切换机会已用完（每个草稿限一次）'
                          : '可切换一次，从下一次对话开始生效'
                      }}
                    </span>
                  </dd>
                  <dt>创建时间</dt>
                  <dd>{{ format_relative_time(draft.created_at) }}</dd>
                  <dt>最近更新</dt>
                  <dd>{{ format_relative_time(draft.updated_at) }}</dd>
                </dl>
              </div>
              <div v-if="draft.status === 'published'" class="result-section status-box success">
                <Icon icon="lucide:check-circle-2" width="16" />
                <span>已发布（{{ format_relative_time(draft.published_at) }}），草稿为只读</span>
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
      :is-update="publishIsUpdate"
      :version="publishVersion"
      @confirm="confirmPublish"
    />

    <!-- 上传插件市场：登录态检测 + 步骤进度 + 结果链接 -->
    <MarketDialog v-model="marketOpen" :draft="draft" />

    <!-- 回退确认：恢复文件状态和对话记录到该消息之前 -->
    <Dialog
      v-model="revertOpen"
      title="回退到该消息之前？"
      description="将撤销这条消息及其后的所有改动，恢复文件状态和对话记录；旧规划与校验结果会失效，需要重新开始。"
      confirm-text="确认回退"
      confirm-variant="danger"
      :loading="reverting"
      @confirm="confirmRevert"
    />

    <!-- 模型切换（一次性）：不选提供商即恢复「自动」，同样消耗切换机会 -->
    <Dialog
      v-model="modelOpen"
      title="切换模型"
      description="每个草稿仅有一次切换机会，确认后不可撤销；新模型从下一次对话开始生效。"
      confirm-text="确认切换"
      :loading="switching"
      @confirm="confirmSwitch"
    >
      <div class="model-form">
        <span v-if="store.optionsError" class="model-hint danger">{{ store.optionsError }}</span>
        <Select
          v-model="modelForm.provider_id"
          :options="providerOptions"
          placeholder="选择提供商（留空恢复自动）"
        />
        <Select
          v-model="modelForm.model_id"
          :options="modelOptions"
          placeholder="自动选择模型"
          :disabled="!modelForm.provider_id"
        />
      </div>
    </Dialog>

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

/* 后端错误横幅：横跨三栏顶部，始终可见 */
.workspace-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-break: break-word;
  flex-shrink: 0;
}

.workspace-banner.danger {
  color: var(--danger);
  background: var(--danger-soft);
  border-bottom: 1px solid #fecaca;
}

.workspace-banner.warning {
  color: var(--warning);
  background: var(--warning-soft);
  border-bottom: 1px solid #fde68a;
}

.workspace-banner.warning .spin {
  animation: banner-spin 1.6s linear infinite;
}

@keyframes banner-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.workspace-banner :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
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
  /* 顶部留出更宽的内边距，让右侧内容（功能摘要/校验/设置）与标题栏边缘保持距离 */
  padding: var(--space-4) var(--space-4) var(--space-4);
}

.preview-holder {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: var(--space-3);
  display: flex;
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

.model-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.link:disabled {
  opacity: 0.5;
  cursor: default;
}

.model-hint {
  display: block;
  margin-top: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.model-hint.danger {
  color: var(--danger);
}

.model-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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
