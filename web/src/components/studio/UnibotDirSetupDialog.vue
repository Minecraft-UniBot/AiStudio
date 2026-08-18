<script setup>
// UniBot 目录设置对话框（首次登录引导 + 设置页编辑共用）
// - 调用 PATCH /settings { unibot_dir } 保存，后端校验目录是否为合法 UniBot 根
// - 保存成功后 emit('saved', dir)，由调用方刷新状态
import { ref, watch } from 'vue'
import { Icon } from '@iconify/vue'
import { api } from '@/utils/api'
import Dialog from '@/components/ui/Dialog.vue'
import Input from '@/components/ui/Input.vue'
import Button from '@/components/ui/Button.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 当前已配置/探测到的目录，用作输入框初值 */
  currentDir: { type: String, default: '' },
  /** 引导模式：首次登录时展示，提供「稍后再说」入口且标题带引导语气 */
  onboarding: { type: Boolean, default: false },
})

const emit = defineEmits(['update:open', 'saved'])

const dir = ref('')
const error = ref('')
const saving = ref(false)

// 打开时用当前目录回填输入框，清空错误
watch(
  () => props.open,
  (open) => {
    if (open) {
      dir.value = props.currentDir || ''
      error.value = ''
    }
  },
)

function close() {
  emit('update:open', false)
}

async function save() {
  const text = dir.value.trim()
  if (!text) {
    error.value = '请输入 UniBot 目录路径'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const result = await api('/settings', { method: 'PATCH', body: { unibot_dir: text } })
    emit('saved', result.unibot_dir)
    close()
  } catch (e) {
    error.value = e.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog
    :open="open"
    :title="onboarding ? '设置 UniBot 目录' : '修改 UniBot 目录'"
    :description="
      onboarding
        ? '发布扩展时需要把文件交付到 UniBot 的 Extensions 目录，请确认 UniBot 的根目录。'
        : '指定 UniBot 根目录（Extensions 的父目录），保存后立即生效。'
    "
    :hide-footer="true"
    width="min(560px, calc(100vw - 32px))"
    @update:open="(value) => emit('update:open', value)"
  >
    <div class="setup-field">
      <label class="setup-label">
        <Icon icon="lucide:folder-tree" width="14" />
        UniBot 目录路径
      </label>
      <Input
        v-model="dir"
        class="mono"
        placeholder="例如：/Users/you/Code/UniBot 或 D:\\UniBot"
        @keydown.enter="save"
      />
      <p v-if="error" class="setup-error">
        <Icon icon="lucide:alert-circle" width="13" />
        {{ error }}
      </p>
      <p class="setup-tip">
        <Icon icon="lucide:info" width="12" />
        该目录需含 <code>Bot.py</code> 或 <code>Extensions</code> 文件夹，发布目标为其中的
        <code>Extensions/&lt;扩展ID&gt;</code>。
      </p>
    </div>

    <div class="setup-footer">
      <Button v-if="onboarding" variant="ghost" :disabled="saving" @click="close">稍后再说</Button>
      <div class="spacer" />
      <Button variant="ghost" :disabled="saving" @click="close">取消</Button>
      <Button variant="primary" :loading="saving" @click="save">
        <Icon v-if="!saving" icon="lucide:check" width="15" />
        保存
      </Button>
    </div>
  </Dialog>
</template>

<style scoped>
.setup-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.setup-label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.setup-label svg {
  color: var(--accent);
}

.setup-error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  color: var(--danger);
  font-size: var(--text-sm);
}

.setup-tip {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.6;
}

.setup-tip svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.setup-tip code {
  padding: 0 4px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
}

.setup-footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-5);
}

.spacer {
  flex: 1;
}
</style>
