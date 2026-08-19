<script setup>
// 模板预览（工作台右栏）：把渲染包/模板扩展的 Jinja2 模板渲染成 HTML，用 iframe srcdoc 预览。
// 后端 preview 端点（preview.ts + preview_template.py）已用内置测试数据渲染.
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import Select from '@/components/ui/Select.vue'
import Spinner from '@/components/ui/Spinner.vue'

const props = defineProps({ draftId: { type: String, required: true } })

const store = useStudioStore()

const templates = ref([])
const current = ref('')
const html = ref('')
const loading = ref(false)
const error = ref('')

let debounce = null
let refresh_token = 0

/** 拉取可用模板名，尽量保留当前选择 */
async function loadNames() {
  try {
    const names = await store.fetchPreviewNames(props.draftId)
    templates.value = names
    if (names.length === 0) {
      current.value = ''
      html.value = ''
      error.value = ''
      return
    }
    if (!current.value || !names.includes(current.value)) current.value = names[0]
  } catch (e) {
    error.value = e.message || '模板列表读取失败'
  }
}

async function render() {
  if (!current.value) {
    html.value = ''
    return
  }
  const token = ++refresh_token
  loading.value = true
  error.value = ''
  try {
    const res = await store.renderPreview(props.draftId, current.value)
    if (token !== refresh_token) return // 已切换到新请求，丢弃过期结果
    html.value = res.html
  } catch (e) {
    if (token !== refresh_token) return
    error.value = e.message || '模板渲染失败'
    html.value = ''
  } finally {
    if (token === refresh_token) loading.value = false
  }
}

/** 文件变化（AI 编辑模板）后防抖重渲染 */
function scheduleRefresh() {
  clearTimeout(debounce)
  debounce = setTimeout(() => {
    loadNames().then(() => render()).catch(() => {})
  }, 600)
}

watch(
  () => store.files,
  () => scheduleRefresh(),
)

watch(current, () => render())

onMounted(() => loadNames().then(() => render()).catch(() => {}))

onUnmounted(() => {
  clearTimeout(debounce)
  refresh_token++
})
</script>

<template>
  <div class="preview">
    <div class="preview-head">
      <label class="form-label">预览模板</label>
      <Select
        v-model="current"
        :options="templates.map((name) => ({ value: name, label: name }))"
        placeholder="选择模板"
        :disabled="!templates.length"
      />
    </div>

    <div v-if="loading" class="preview-state">
      <Spinner :size="16" />
      <span>渲染中…</span>
    </div>

    <div v-else-if="error" class="preview-state danger">
      <Icon icon="lucide:alert-triangle" width="15" />
      <span>{{ error }}</span>
    </div>

    <div v-else-if="!templates.length" class="preview-state">
      <Icon icon="lucide:layout-template" width="18" />
      <span>该草稿暂无模板可预览。创建渲染包（模板）扩展后，从这里实时查看效果。</span>
    </div>

    <div v-else class="preview-frame">
      <iframe
        :srcdoc="html"
        title="模板预览"
        sandbox="allow-same-origin"
      />
    </div>

    <p class="preview-note">预览使用内置测试数据渲染，实际以 UniBot 运行时的数据为准。</p>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: var(--space-3);
}

.preview-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex-shrink: 0;
}

.form-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.preview-frame {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #10201a;
  overflow: hidden;
}

.preview-frame iframe {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
}

.preview-state {
  flex: 1;
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  text-align: center;
  padding: var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.preview-state.danger {
  color: var(--danger);
}

.preview-note {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  flex-shrink: 0;
}
</style>