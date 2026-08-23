<script setup>
// 添加自定义 OpenAI 兼容模型提供商（NewApi / one-api 等中转网关）。
// 默认预填 LS Api（NewApi）：地址 https://api.keishi.cn/v1，只需粘贴 API Key。
// 保存后后端写入 opencode 配置并重启生效；模型列表留空时自动从 {地址}/models 拉取。
import { reactive, ref, computed, watch } from 'vue'
import Dialog from '@/components/ui/Dialog.vue'
import Input from '@/components/ui/Input.vue'
import Textarea from '@/components/ui/Textarea.vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'

const open = defineModel({ type: Boolean, default: false })

const emit = defineEmits(['saved'])

const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

/** 默认预填：LS Api（NewApi 网关） */
const DEFAULTS = {
  name: 'LS Api',
  base_url: 'https://api.keishi.cn/v1',
}

const saving = ref(false)
const form = reactive({
  name: '',
  base_url: '',
  api_key: '',
  models_text: '',
})

watch(open, (val) => {
  if (val) {
    form.name = DEFAULTS.name
    form.base_url = DEFAULTS.base_url
    form.api_key = ''
    form.models_text = ''
  }
})

/** 手动填写的模型 ID（逗号/换行/空格分隔）；留空则由后端自动拉取 */
const manualModels = computed(() =>
  form.models_text.split(/[\n,，;；\s]+/).map((s) => s.trim()).filter(Boolean),
)

async function submit() {
  if (!form.name.trim() || !form.base_url.trim() || !form.api_key.trim()) {
    toast_error('请填写名称、API 地址和 API Key')
    return
  }
  saving.value = true
  try {
    await store.addCustomProvider({
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      api_key: form.api_key.trim(),
      ...(manualModels.value.length ? { models: manualModels.value } : {}),
    })
    toast_success('提供商已添加并重载 OpenCode')
    open.value = false
    emit('saved')
  } catch (e) {
    toast_error(e.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    v-model="open"
    title="添加 OpenAI 兼容提供商"
    description="支持 NewApi、one-api 等任何 OpenAI 兼容网关。保存后会重启 OpenCode 使其生效，进行中的生成会中断。"
    confirm-text="保存并重载"
    :loading="saving"
    width="min(520px, calc(100vw - 32px))"
    @confirm="submit"
  >
    <div class="provider-form">
      <div class="field">
        <label class="form-label">名称</label>
        <Input v-model="form.name" placeholder="如 LS Api" />
        <span class="form-hint">显示在模型选择器中的提供商名</span>
      </div>
      <div class="field">
        <label class="form-label">API 地址</label>
        <Input v-model="form.base_url" placeholder="https://example.com/v1" />
        <span class="form-hint">OpenAI 兼容接口根地址，通常以 /v1 结尾</span>
      </div>
      <div class="field">
        <label class="form-label">API Key</label>
        <Input v-model="form.api_key" type="password" placeholder="sk-…" />
        <span class="form-hint">仅保存在本机服务端配置中，不会上传到任何第三方</span>
      </div>
      <div class="field">
        <label class="form-label">模型列表（可选）</label>
        <Textarea
          v-model="form.models_text"
          :rows="3"
          placeholder="留空自动获取；也可手动填写，用逗号或换行分隔&#10;如：gpt-4o, deepseek-chat"
        />
        <span class="form-hint">
          {{ manualModels.length ? `将使用手动填写的 ${manualModels.length} 个模型` : '保存时自动请求 地址/models 获取可用模型' }}
        </span>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.provider-form {
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
</style>
