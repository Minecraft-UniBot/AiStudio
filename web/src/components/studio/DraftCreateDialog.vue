<script setup>
// 新建扩展草稿对话框（Plan 3.1：ID / 名称 / 描述 / 类型 / 模型 / Agent）
import { ref, computed } from 'vue'
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
const { error: toast_error } = use_toast()

const creating = ref(false)
const form = ref({
  extension_id: '',
  name: '',
  description: '',
  types: ['command'],
  provider_id: '',
  model_id: '',
  agent: 'build',
})

const providerOptions = computed(() =>
  store.options.providers.map((p) => ({ value: p.provider_id, label: p.label })),
)

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
  creating.value = true
  try {
    const draft = await store.createDraft({
      extension_id: form.value.extension_id,
      name: form.value.name,
      description: form.value.description,
      types: form.value.types,
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

function toggleType(type) {
  form.value.types = form.value.types.includes(type)
    ? form.value.types.filter((x) => x !== type)
    : [...form.value.types, type]
}
</script>

<template>
  <Dialog
    v-model="open"
    title="新建扩展草稿"
    description="AI 会先向你确认需求细节并规划，再自动编写代码，最后独立审查。全程在隔离工作区中进行"
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
          placeholder="例如：新增 /weather 指令查询天气，可配置城市和语言"
        />
        <span class="form-hint">作为第一条需求上下文</span>
      </div>
      <div class="field">
        <label class="form-label">扩展类型</label>
        <div class="type-group">
          <button
            v-for="type in ['command', 'api']"
            :key="type"
            type="button"
            class="type-chip"
            :class="{ active: form.types.includes(type) }"
            @click="toggleType(type)"
          >
            <Icon
              :icon="form.types.includes(type) ? 'lucide:check' : 'lucide:plus'"
              width="13"
            />
            {{ TYPE_LABELS[type] }}
          </button>
        </div>
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
</style>
