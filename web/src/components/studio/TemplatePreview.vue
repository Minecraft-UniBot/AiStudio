<script setup>
// 模板预览（工作台右栏）：把渲染包/模板扩展的 Jinja2 模板渲染成 HTML，用 iframe srcdoc 预览。
// 后端 preview 端点（preview.ts + preview_template.py）已用内置测试数据渲染.
// 缩放：模板按固定宽度（默认 720px）渲染，右栏较窄时用 transform: scale 等比缩小，
// 外层 viewport 负责滚动；iframe 实际内容尺寸在 onload 后读取，保证容器贴合内容。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
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

// 缩放相关：默认渲染宽度 720px（与 preview_template.py 的 width 一致）
const DEFAULT_W = 720
const viewport = ref(null)
const frame = ref(null)
const base_w = ref(DEFAULT_W) // 模板实际渲染宽度（onload 后按内容校准）
const frame_h = ref(760) // iframe 内容实际高度（onload 后校准）
const scale = ref(1) // 缩放比（宽高等比，上限 1 不放大）
/** 适配模式：fit = 同时考虑宽高，整页缩进可视区；width = 只按宽度铺满，高度超出可滚动 */
const fit_mode = ref('fit')

const canvas_style = computed(() => ({
  width: `${Math.round(base_w.value * scale.value)}px`,
  height: `${Math.round(frame_h.value * scale.value)}px`,
}))

const frame_style = computed(() => ({
  width: `${base_w.value}px`,
  height: `${frame_h.value}px`,
  transform: `scale(${scale.value})`,
}))

/** 按 viewport 可用宽高计算缩放比（保留两侧内边距） */
function measure() {
  if (!viewport.value) return
  const avail_w = viewport.value.clientWidth - 2 * 8 // --space-2
  const avail_h = viewport.value.clientHeight - 2 * 8
  const width_scale = avail_w / base_w.value
  const height_scale = avail_h / frame_h.value
  // 整页适配：取宽高比例较小者，保证完整内容落在可视区内；宽度适配只看宽度
  const raw = fit_mode.value === 'fit'
    ? Math.min(width_scale, height_scale)
    : width_scale
  scale.value = Math.min(1, Math.max(0.1, raw))
}

/** iframe 加载完成：读取内容实际宽高，使缩放后的画布贴合内容 */
function onFrameLoad() {
  const doc = frame.value?.contentDocument
  if (!doc?.documentElement) return
  try {
    const w = doc.documentElement.scrollWidth
    const h = doc.documentElement.scrollHeight
    if (w && w > 40) base_w.value = w
    if (h && h > 40) frame_h.value = h
    measure()
  } catch {
    // sandbox 下 DOM 不可读时保持默认尺寸
  }
}

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
    // 新内容：先重置为默认尺寸，等 iframe onload 按实际内容校准
    base_w.value = DEFAULT_W
    frame_h.value = 760
    measure()
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

let ro = null
onMounted(() => {
  ro = new ResizeObserver(() => measure())
  if (viewport.value) ro.observe(viewport.value)
  measure()
  loadNames().then(() => render()).catch(() => {})
})

onUnmounted(() => {
  ro?.disconnect()
  clearTimeout(debounce)
  refresh_token++
})
</script>

<template>
  <div class="preview">
    <div class="preview-head">
      <div class="head-row">
        <label class="form-label">预览模板</label>
        <div class="fit-toggle" role="group" aria-label="适配模式">
          <button
            type="button"
            class="fit-btn"
            :class="{ active: fit_mode === 'fit' }"
            title="整页缩进可视区，一屏看全"
            @click="fit_mode = 'fit'; measure()"
          >
            整页
          </button>
          <button
            type="button"
            class="fit-btn"
            :class="{ active: fit_mode === 'width' }"
            title="按宽度铺满，高度超出可滚动查看"
            @click="fit_mode = 'width'; measure()"
          >
            宽度
          </button>
        </div>
      </div>
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

    <div v-else ref="viewport" class="preview-viewport">
      <div class="preview-canvas" :style="canvas_style">
        <iframe
          ref="frame"
          :srcdoc="html"
          :style="frame_style"
          title="模板预览"
          sandbox="allow-same-origin"
          @load="onFrameLoad"
        />
      </div>
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

.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.form-label {
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-secondary);
}

.fit-toggle {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.fit-btn {
  padding: 2px 8px;
  border: none;
  background: transparent;
  font-size: var(--text-xs);
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color var(--transition),
    background-color var(--transition);
}

.fit-btn + .fit-btn {
  border-left: 1px solid var(--border);
}

.fit-btn:hover {
  color: var(--text);
}

.fit-btn.active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

.preview-viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-2);
}

.preview-canvas {
  position: relative;
  overflow: hidden;
  background: #10201a;
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.preview-canvas iframe {
  display: block;
  border: none;
  transform-origin: 0 0;
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
