<script setup>
// 平台设置：功能开关、OpenCode 工具注册表、提示词管理（版本化）、校验步骤编排
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '@/utils/api'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import Button from '@/components/ui/Button.vue'
import Checkbox from '@/components/ui/Checkbox.vue'
import Badge from '@/components/ui/Badge.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Select from '@/components/ui/Select.vue'

const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const settings = ref(null)
const tools = ref([])
const prompts = ref([])
const validationSteps = ref([])
const saving = ref(false)

// 提示词编辑
const editingPrompt = ref(null) // { name, content, version }
const promptEditorOpen = ref(false)
const promptSaving = ref(false)
const selectedPromptVersions = ref([])

onMounted(async () => {
  store.fetchStatus()
  await loadAll()
})

async function loadAll() {
  const results = await Promise.allSettled([
    api('/settings'),
    api('/tools'),
    api('/prompts'),
    api('/validation/steps'),
  ])
  if (results[0].status === 'fulfilled') settings.value = results[0].value
  if (results[1].status === 'fulfilled') tools.value = results[1].value
  if (results[2].status === 'fulfilled') prompts.value = results[2].value
  if (results[3].status === 'fulfilled') validationSteps.value = results[3].value
}

async function saveSettings() {
  saving.value = true
  try {
    settings.value = await api('/settings', {
      method: 'PATCH',
      body: { features: settings.value.features },
    })
    toast_success('设置已保存')
  } catch (e) {
    toast_error(e.message)
  } finally {
    saving.value = false
  }
}

async function toggleTool(tool) {
  tool.enabled = !tool.enabled
  try {
    tools.value = await api('/tools', { method: 'PATCH', body: tools.value })
  } catch (e) {
    tool.enabled = !tool.enabled
    toast_error(e.message)
  }
}

// ===== 提示词管理（Plan 7.1：编辑、预览、启用版本、回滚） =====
function openPromptEditor(prompt) {
  selectedPromptVersions.value = prompt.versions
  const latest = prompt.versions[prompt.versions.length - 1]
  editingPrompt.value = {
    name: prompt.name,
    content: latest.content,
    version: latest.version,
    current_version: prompt.current_version,
  }
  promptEditorOpen.value = true
}

async function savePromptVersion() {
  if (!editingPrompt.value?.content) return
  promptSaving.value = true
  try {
    const created = await api(`/prompts/${editingPrompt.value.name}`, {
      method: 'POST',
      body: { content: editingPrompt.value.content },
    })
    toast_success(`已保存为 v${created.version}（未自动启用，可在下方启用）`)
    promptEditorOpen.value = false
    prompts.value = await api('/prompts')
  } catch (e) {
    toast_error(e.message)
  } finally {
    promptSaving.value = false
  }
}

async function activateVersion(prompt, version) {
  try {
    await api(`/prompts/${prompt.name}/activate`, {
      method: 'POST',
      body: { version },
    })
    toast_success(`已启用 ${prompt.name} v${version}`)
    prompts.value = await api('/prompts')
  } catch (e) {
    toast_error(e.message)
  }
}

// ===== 校验步骤编排（Plan 8.3：启停 + 排序） =====
async function toggleValidationStep(step) {
  step.enabled = !step.enabled
  await persistValidationSteps()
}

async function moveValidationStep(step, direction) {
  const idx = validationSteps.value.findIndex((item) => item.id === step.id)
  const target = idx + direction
  if (target < 0 || target >= validationSteps.value.length) return
  const [moved] = validationSteps.value.splice(idx, 1)
  validationSteps.value.splice(target, 0, moved)
  await persistValidationSteps()
}

async function persistValidationSteps() {
  try {
    const next = await api('/validation/steps', {
      method: 'PATCH',
      body: validationSteps.value.map((step, index) => ({
        id: step.id,
        enabled: step.enabled,
        order: index,
      })),
    })
    validationSteps.value = next
    toast_success('校验步骤已更新')
  } catch (e) {
    toast_error(e.message)
    validationSteps.value = await api('/validation/steps')
  }
}

function permissionVariant(permission) {
  if (permission === 'reject') return 'danger'
  if (permission === 'ask') return 'warning'
  return 'neutral'
}
</script>

<template>
  <div class="admin-page">
    <header class="topbar">
      <Button variant="ghost" icon-only title="返回草稿列表" @click="router.push('/')">
        <Icon icon="lucide:arrow-left" width="16" />
      </Button>
      <span class="title">平台设置</span>
      <div class="spacer" />
      <Badge :variant="store.opencodeAvailable ? 'success' : 'neutral'">
        <span class="status-dot" />
        OpenCode {{ store.status?.version ?? '未连接' }}
      </Badge>
    </header>

    <main class="content">
      <!-- 功能开关 -->
      <section v-if="settings" class="card">
        <h3>功能开关</h3>
        <div class="feature-list">
          <label class="feature-item">
            <Checkbox v-model="settings.features.review" />
            <div>
              <span>AI 审核与调试</span>
              <small>生成后由独立 AI 审核并自动修复问题</small>
            </div>
          </label>
          <label class="feature-item disabled">
            <Checkbox v-model="settings.features.mc_test_environment" disabled />
            <div>
              <span>MC 测试环境</span>
              <small>备用方案，暂未实现</small>
            </div>
          </label>
          <label class="feature-item disabled">
            <Checkbox v-model="settings.features.market_publish" disabled />
            <div>
              <span>市场发布</span>
              <small>暂未实现</small>
            </div>
          </label>
          <label class="feature-item disabled">
            <Checkbox v-model="settings.features.git_integration" disabled />
            <div>
              <span>Git / PR 工作流</span>
              <small>暂未实现</small>
            </div>
          </label>
        </div>
        <Button variant="primary" :loading="saving" @click="saveSettings">
          <Icon icon="lucide:save" width="15" /> {{ saving ? '保存中…' : '保存设置' }}
        </Button>
      </section>

      <!-- 工具注册表 -->
      <section class="card">
        <h3>OpenCode 工具注册表</h3>
        <div class="tool-list">
          <div v-for="tool in tools" :key="tool.id" class="tool-item">
            <div class="tool-info">
              <span class="mono">{{ tool.id }}</span>
              <small>{{ tool.note }}</small>
            </div>
            <div class="tool-meta">
              <Badge :variant="permissionVariant(tool.default_permission)">
                {{ tool.default_permission }}
              </Badge>
              <Button size="sm" :variant="tool.enabled ? 'primary' : 'secondary'" @click="toggleTool(tool)">
                {{ tool.enabled ? '已启用' : '已停用' }}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <!-- 校验步骤编排（Plan 8.3） -->
      <section class="card">
        <h3>校验步骤编排</h3>
        <p class="card-sub">可独立启停、调整顺序；保存后立即生效。</p>
        <div class="step-order-list">
          <div v-for="(step, index) in validationSteps" :key="step.id" class="step-order-item">
            <div class="step-order-info">
              <span class="order-badge mono">{{ index + 1 }}</span>
              <span class="step-order-name">{{ step.name }}</span>
            </div>
            <div class="step-order-actions">
              <Button
                variant="ghost"
                icon-only
                size="sm"
                title="上移"
                :disabled="index === 0"
                @click="moveValidationStep(step, -1)"
              >
                <Icon icon="lucide:chevron-up" width="14" />
              </Button>
              <Button
                variant="ghost"
                icon-only
                size="sm"
                title="下移"
                :disabled="index === validationSteps.length - 1"
                @click="moveValidationStep(step, 1)"
              >
                <Icon icon="lucide:chevron-down" width="14" />
              </Button>
              <Button size="sm" :variant="step.enabled ? 'primary' : 'secondary'" @click="toggleValidationStep(step)">
                {{ step.enabled ? '已启用' : '已停用' }}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <!-- 提示词管理（Plan 7.1） -->
      <section class="card">
        <h3>提示词模板</h3>
        <p class="card-sub">修改后保存为新版本（旧版本保留可回滚）；启用版本后立即生效。</p>
        <div class="prompt-list">
          <div v-for="prompt in prompts" :key="prompt.name" class="prompt-item">
            <div class="prompt-info">
              <span class="mono prompt-name">{{ prompt.name }}.md</span>
              <small>当前 v{{ prompt.current_version }} · {{ prompt.versions.length }} 个版本</small>
            </div>
            <div class="prompt-actions">
              <Select
                :model-value="String(prompt.current_version)"
                :options="prompt.versions.map((v) => ({ value: String(v.version), label: `v${v.version}${v.version === prompt.current_version ? '（当前）' : ''}` }))"
                class="version-select"
                @update:model-value="(value) => activateVersion(prompt, Number(value))"
              />
              <Button size="sm" @click="openPromptEditor(prompt)">
                <Icon icon="lucide:pencil" width="13" /> 编辑
              </Button>
            </div>
          </div>
        </div>
      </section>

      <!-- 目录信息 -->
      <section class="card">
        <h3>目录信息</h3>
        <dl class="info-grid">
          <dt>平台数据</dt>
          <dd class="mono">{{ store.status?.data_dir ?? '~/.unibot-studio' }}</dd>
          <dt>UniBot 目录</dt>
          <dd class="mono">{{ store.status?.unibot_dir }}</dd>
          <dt>扩展目录</dt>
          <dd class="mono">{{ store.status?.extensions_dir }}</dd>
        </dl>
      </section>
    </main>

    <!-- 提示词编辑器 -->
    <Dialog
      v-model="promptEditorOpen"
      title="编辑提示词模板"
      :description="editingPrompt ? `正在编辑 ${editingPrompt.name}.md（基于 v${editingPrompt.version}）` : ''"
      confirm-text="保存为新版本"
      :loading="promptSaving"
      width="min(640px, calc(100vw - 32px))"
      @confirm="savePromptVersion"
    >
      <p v-if="editingPrompt" class="editor-tip">
        保存后生成新版本（v{{ editingPrompt.version + 1 }}），不会自动启用；可在列表中选择版本启用或回滚。
      </p>
      <Textarea
        v-model="editingPrompt.content"
        :rows="16"
        class="prompt-editor mono"
        placeholder="模板正文（支持 {{placeholder}} 占位符）"
      />
    </Dialog>
  </div>
</template>

<style scoped>
.admin-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: var(--topbar-height);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
  background: var(--surface);
}

.title {
  font-weight: 600;
  font-size: var(--text-md);
  letter-spacing: -0.01em;
}

.spacer {
  flex: 1;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-6);
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-5);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.card h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
  font-weight: 600;
}

.card-sub {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.feature-list,
.tool-list,
.prompt-list,
.step-order-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.feature-item {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  cursor: pointer;
  padding: var(--space-2);
  border-radius: var(--radius);
  transition: background-color var(--transition);
}

.feature-item:hover {
  background: var(--surface-sunken);
}

.feature-item.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.feature-item span {
  display: block;
  font-size: var(--text-sm);
  font-weight: 500;
}

.feature-item small {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.tool-item,
.step-order-item,
.prompt-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.tool-info,
.prompt-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tool-info small,
.prompt-info small {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.tool-meta,
.prompt-actions,
.step-order-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.step-order-item {
  justify-content: space-between;
}

.step-order-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.order-badge {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: var(--text-xs);
  font-weight: 600;
}

.step-order-name {
  font-size: var(--text-sm);
}

.version-select {
  min-width: 140px;
}

.editor-tip {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
  line-height: 1.5;
}

.prompt-editor {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.info-grid {
  display: grid;
  grid-template-columns: 90px 1fr;
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
</style>
