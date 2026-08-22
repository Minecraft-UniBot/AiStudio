<script setup>
// 新建扩展草稿对话框（Plan 3.1：ID / 名称 / 描述 / 扩展类型 / 模板 / 模型 / Agent）
// 扩展类型为主选择：渲染包（模板）/ 资源 / 代码；选代码后再细分指令或 API，模板由类型自动决定。
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import { TYPE_LABELS } from '@/utils/draft_status'
import Dialog from '@/components/ui/Dialog.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Select from '@/components/ui/Select.vue'

const open = defineModel({ type: Boolean, default: false })

const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const creating = ref(false)
const pulling = ref(false)
const form = ref({
  extension_id: '',
  name: '',
  description: '',
  extension_kind: 'code', // code | template | resources
  code_types: ['command'], // 仅代码型：细分 command / api
  provider_id: '',
  model_id: '',
  agent: 'build',
})

// 打开对话框时刷新模板列表与目标服务器状态
// （Default 模板可能在启动后仍在后台拉取；MC 服务器可能刚在其他页面设置过）
watch(open, (val) => {
  if (val) {
    store.fetchTemplates().catch(() => {})
    store.fetchMcServer().catch(() => {})
  }
})

/** 扩展类型主选项（单选） */
const kindOptions = [
  { value: 'template', label: '渲染包扩展' },
  { value: 'resources', label: '资源扩展' },
  { value: 'code', label: '代码扩展' },
]

/** 代码型子选项（仅 kind=code 时显示） */
const codeTypeOptions = [
  { value: 'command', label: TYPE_LABELS.command },
  { value: 'api', label: TYPE_LABELS.api },
]

/** 依据主类型推导提交的 types */
const payload_types = computed(() => {
  switch (form.value.extension_kind) {
    case 'template':
      return ['template']
    case 'resources':
      return ['resources']
    default:
      return form.value.code_types.length ? form.value.code_types : ['command']
  }
})

/** 依据主类型推导使用的开发模板 */
const chosen_template_id = computed(() => {
  // 渲染包/资源 → Default 模板；代码型 → 内置最小脚手架
  return form.value.extension_kind === 'code' ? 'minimal' : 'Default'
})

/** 是否需要 Default 扩展模板（渲染包/资源场景） */
const needs_default = computed(() => form.value.extension_kind !== 'code')

/** Default 模板是否已就绪 */
const default_ready = computed(() => {
  const t = store.templates.find((x) => x.id === 'Default')
  return t ? t.installed : false
})

/** 模板选择提示文案（由主类型自动决定，不再单独弹模板下拉） */
const kindHint = computed(() => {
  switch (form.value.extension_kind) {
    case 'template':
      return '从默认模板（Default）克隆 Templates 素材起步，AI 帮你定制版式与配色'
    case 'resources':
      return '从默认模板（Default）克隆 Resources 素材起步，AI 帮你整理图片/字体/样式片段'
    default:
      return `内置最小脚手架：从空白的 ${form.value.code_types.map((t) => TYPE_LABELS[t]).join(' / ') || '代码'} 开始，AI 直接实现`
  }
})

/** 描述占位文案（随扩展类型变化） */
const description_placeholder = computed(() => {
  switch (form.value.extension_kind) {
    case 'template':
      return '例如：把列表/状态卡片做成更清爽的版式，主色改成墨绿'
    case 'resources':
      return '例如：内置一套方块纹理背景图与配套字体'
    default:
      return '例如：新增 /weather 指令查询天气，可配置城市和语言'
  }
})

async function retryPullTemplate() {
  if (!needs_default.value) return
  pulling.value = true
  try {
    const updated = await store.pullTemplate('Default')
    const ready = updated.find((t) => t.id === 'Default')
    if (ready?.installed) toast_success(`模板「${ready.name}」已就绪`)
  } catch (e) {
    toast_error(e.message)
  } finally {
    pulling.value = false
  }
}

const providerOptions = computed(() =>
  store.options.providers.map((p) => ({ value: p.provider_id, label: p.label })),
)

// ---- 目标 MC 服务器 ----
const mc_picking = ref(false)

/** 已选服务器摘要（如「Paper · 1.21.4 · 插件 12 / 模组 3」） */
const mc_summary = computed(() => {
  const info = store.mcServer?.info
  if (!info) return ''
  const parts = [info.label]
  if (info.mc_version) parts.push(info.mc_version)
  const counts = []
  if (info.plugins?.length) counts.push(`插件 ${info.plugins.length}`)
  if (info.mods?.length) counts.push(`模组 ${info.mods.length}`)
  if (counts.length) parts.push(counts.join(' / '))
  return parts.join(' · ')
})

/**
 * 弹出系统目录选择窗口（由后端在本机打开）：选中后自动扫描并保存；
 * 用户取消则静默返回，不打扰。
 */
async function pickServer() {
  mc_picking.value = true
  try {
    const data = await store.pickMcServer()
    if (data.picked) {
      toast_success(`目标服务器已设置：${data.info?.label ?? data.dir}`)
    }
  } catch (e) {
    toast_error(e.message)
  } finally {
    mc_picking.value = false
  }
}

async function removeMcServer() {
  try {
    await store.clearMcServer()
  } catch (e) {
    toast_error(e.message)
  }
}

const providerModels = computed(() => {
  const provider = store.options.providers.find((p) => p.provider_id === form.value.provider_id)
  return provider?.models ?? []
})

const modelOptions = computed(() =>
  providerModels.value.map((m) => ({ value: m.id, label: m.label })),
)

async function create() {
  if (!form.value.extension_id || !form.value.name || !form.value.description) {
    toast_error('请填写扩展 ID、显示名称和功能描述')
    return
  }
  // 代码型至少选一种细分类型
  if (form.value.extension_kind === 'code' && form.value.code_types.length === 0) {
    toast_error('请至少选择一种扩展类型（指令或 API）')
    return
  }
  // 需要 Default 模板但未就绪：阻止提交并提示先拉取
  if (needs_default.value && !default_ready.value) {
    toast_error('渲染/资源模板尚未就绪，请先点「立即拉取」')
    return
  }
  creating.value = true
  try {
    const draft = await store.createDraft({
      extension_id: form.value.extension_id,
      name: form.value.name,
      description: form.value.description,
      types: payload_types.value,
      template_id: chosen_template_id.value,
      model:
        form.value.provider_id && form.value.model_id
          ? { provider_id: form.value.provider_id, model_id: form.value.model_id }
          : null,
      agent: form.value.agent,
    })
    open.value = false
    router.push(`/workspace/${draft.id}`)
  } catch (e) {
    toast_error(e.message)
  } finally {
    creating.value = false
  }
}

function toggleCodeType(type) {
  form.value.code_types = form.value.code_types.includes(type)
    ? form.value.code_types.filter((x) => x !== type)
    : [...form.value.code_types, type]
}
</script>

<template>
  <Dialog
    v-model="open"
    title="新建扩展草稿"
    description="AI 会先向你确认需求细节并规划，再自动编写代码，编码过程中用测试工具在测试环境自测。全程在隔离工作区中进行"
    confirm-text="创建并开始规划"
    :loading="creating"
    width="min(520px, calc(100vw - 32px))"
    @confirm="create"
  >
    <div class="draft-form">
      <div class="field">
        <label class="form-label">扩展 ID</label>
        <Input v-model="form.extension_id" placeholder="如 WeatherExt" />
        <span class="form-hint">PascalCase，创建后不可修改</span>
      </div>
      <div class="field">
        <label class="form-label">显示名称</label>
        <Input v-model="form.name" placeholder="如 天气查询" />
      </div>
      <div class="field">
        <label class="form-label">功能描述</label>
        <Textarea
          v-model="form.description"
          :rows="3"
          :placeholder="description_placeholder"
        />
        <span class="form-hint">作为第一条需求上下文</span>
      </div>
      <div class="field">
        <label class="form-label">扩展类型</label>
        <Select v-model="form.extension_kind" :options="kindOptions" placeholder="选择扩展类型" />
        <span class="form-hint">{{ kindHint }}</span>
        <div v-if="needs_default && !default_ready" class="form-hint danger">
          <span>渲染/资源模板「Default」尚未就绪（启动时后台拉取中），需要先就绪才能创建该类扩展。</span>
          <button type="button" class="link" :disabled="pulling" @click="retryPullTemplate">
            {{ pulling ? '拉取中…' : '立即拉取' }}
          </button>
        </div>
        <span v-else-if="store.templatesError" class="form-hint danger">
          {{ store.templatesError }}
        </span>
      </div>
      <div v-if="form.extension_kind === 'code'" class="field">
        <label class="form-label">代码类型</label>
        <div class="type-group">
          <button
            v-for="type in codeTypeOptions"
            :key="type.value"
            type="button"
            class="type-chip"
            :class="{ active: form.code_types.includes(type.value) }"
            @click="toggleCodeType(type.value)"
          >
            <Icon
              :icon="form.code_types.includes(type.value) ? 'lucide:check' : 'lucide:plus'"
              width="13"
            />
            {{ type.label }}
          </button>
        </div>
        <span class="form-hint">指令扩展发送 /xxx 指令，API 扩展提供可复用的服务能力</span>
      </div>
      <div class="field">
        <label class="form-label">目标 MC 服务器（可选）</label>
        <template v-if="store.mcServer?.configured">
          <div class="server-chip">
            <Icon icon="lucide:server" width="14" />
            <span class="server-name">{{ mc_summary }}</span>
            <button type="button" class="link" @click="removeMcServer">移除</button>
          </div>
          <span class="form-hint">
            创建草稿时把服务端类型、版本与已装插件/模组快照提供给 AI，帮助其选择实现方案
          </span>
        </template>
        <template v-else>
          <div>
            <button type="button" class="pick-btn" :disabled="mc_picking" @click="pickServer">
              <Icon :icon="mc_picking ? 'lucide:loader-circle' : 'lucide:folder-open'" width="15" :class="{ spin: mc_picking }" />
              {{ mc_picking ? '等待选择…' : '选择服务器文件夹' }}
            </button>
          </div>
          <span class="form-hint">
            点击后由本机弹出系统目录选择窗口，自动识别服务端（Paper / Fabric / Forge 等）、版本与插件/模组清单
          </span>
        </template>
      </div>
      <div class="field">
        <label class="form-label">模型</label>
        <span v-if="store.optionsError" class="form-hint danger">
          {{ store.optionsError }}
        </span>
        <span v-else class="form-hint">可选，默认使用后端配置</span>
        <div class="row">
          <Select v-model="form.provider_id" :options="providerOptions" placeholder="自动选择" />
          <Select
            v-model="form.model_id"
            :options="modelOptions"
            placeholder="自动选择模型"
            :disabled="!form.provider_id"
          />
        </div>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.draft-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.form-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.form-hint {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.form-hint.danger {
  color: var(--danger);
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

.type-group {
  display: flex;
  gap: var(--space-2);
}

.type-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    border-color var(--transition),
    color var(--transition),
    background-color var(--transition);
}

.type-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.type-chip.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.row {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.row > * {
  flex: 1;
}

.pick-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  justify-content: center;
  height: 34px;
  padding: 0 var(--space-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    border-color var(--transition),
    color var(--transition);
}

.pick-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.pick-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.spin {
  animation: pick-spin 1s linear infinite;
}

@keyframes pick-spin {
  to {
    transform: rotate(360deg);
  }
}

.server-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.server-name {
  color: var(--text);
}
</style>
