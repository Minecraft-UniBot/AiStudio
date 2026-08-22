<script setup>
// 模板预览（工作台右栏）：把渲染包/模板扩展的 Jinja2 模板渲染成 HTML，用 iframe srcdoc 预览。
// 后端 preview 端点（preview.ts + preview_template.py）已用内置测试数据渲染。
// 缩放：模板按固定宽度（默认 720px）渲染，右栏较窄时用 transform: scale 等比缩小，
// 外层 viewport 负责滚动；iframe 实际内容尺寸在 onload 后读取，保证容器贴合内容。
// 放大弹窗：点击预览画布打开 Dialog，直接复用右栏同一份渲染结果放大查看，
// 提供 缩小 / 100% / 放大 / 适应宽度 控制，放大时按住滚动查看细节。
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import Select from '@/components/ui/Select.vue'
import Spinner from '@/components/ui/Spinner.vue'
import Dialog from '@/components/ui/Dialog.vue'

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
const base_w = ref(DEFAULT_W) // 模板内容实际渲染宽度（onload 后按内容校准）
const frame_h = ref(760) // 模板内容实际高度（onload 后校准）
const avail_w = ref(0) // 容器可用宽度（缩放基准）
const scale = ref(1) // 缩放比：只按容器宽度算，上限 1 不放大；高度按内容等比

const canvas_style = computed(() => ({
  width: `${Math.round(avail_w.value)}px`,
  height: `${Math.round(frame_h.value * scale.value)}px`,
}))

const frame_style = computed(() => ({
  width: `${base_w.value}px`,
  height: `${frame_h.value}px`,
  transform: `scale(${scale.value})`,
}))

/**
 * 计算缩放比：以容器宽度为准（canvas 宽度 = 容器可用宽度），
 * 高度按内容等比缩放（内容多高就多高，超出部分由 viewport 滚动）。
 * 不使用容器高度去缩小内容——否则内容较高时会被压得过小。
 */
function measure() {
  if (!viewport.value) return
  avail_w.value = viewport.value.clientWidth - 2 * 8 // --space-2
  const width_scale = avail_w.value / base_w.value
  scale.value = Math.min(1, Math.max(0.1, width_scale))
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

// ---- 放大预览弹窗 ----
// 弹窗复用右栏同一份渲染结果（默认 720×760，高>宽），不改变渲染尺寸——
// 与实际渲染的比例、布局完全一致，避免“拉长”；放大只是纯 CSS transform 缩放，
// 打开零额外渲染成本，AI 编辑触发右栏重渲染后弹窗同步刷新。
const dialog_open = ref(false)
const dialog_html = ref('')
const dialog_error = ref('')
const dialog_body = ref(null) // 弹窗内始终存在的容器（错误/预览态都挂载，作为缩放与 ResizeObserver 的基准）
const dialog_viewport = ref(null)
const dialog_frame = ref(null)
const dialog_base_w = ref(DEFAULT_W) // 与右栏内容宽度一致（onload 后校准）
const dialog_base_h = ref(760)
const dialog_scale = ref(1) // 当前显示缩放（1 = 内容实际尺寸）
const dialog_fit = ref(true) // 适应宽度模式
let dialog_ro = null

const dialog_canvas_style = computed(() => ({
  width: `${Math.round(dialog_base_w.value * dialog_scale.value)}px`,
  height: `${Math.round(dialog_base_h.value * dialog_scale.value)}px`,
}))

const dialog_frame_style = computed(() => ({
  width: `${dialog_base_w.value}px`,
  height: `${dialog_base_h.value}px`,
  transform: `scale(${dialog_scale.value})`,
}))

const dialog_zoom_label = computed(() =>
  dialog_fit.value ? '适应' : `${Math.round(dialog_scale.value * 100)}%`,
)

/** 弹窗缩放：以容器宽度为基准（适应时 scale 上限 1，不放大超出；viewport 未挂载时用 body 宽度） */
function dialog_measure() {
  const el = dialog_viewport.value ?? dialog_body.value
  if (!el) return
  if (dialog_fit.value) {
    // viewport 无内边距，直接按内容区宽度算
    dialog_scale.value = Math.min(1, el.clientWidth / dialog_base_w.value)
  }
}

/** 适应宽度 */
function dialog_fit_width() {
  dialog_fit.value = true
  dialog_measure()
}

/** 步进缩放（step = 1.25 放大 / 0.8 缩小），退出适应模式 */
function dialog_zoom(step) {
  dialog_fit.value = false
  dialog_scale.value = Math.min(8, Math.max(0.25, dialog_scale.value * step))
}

/** 100% 原始尺寸 */
function dialog_zoom_100() {
  dialog_fit.value = false
  dialog_scale.value = 1
}

/** 打开弹窗：复用右栏已渲染的内容放大查看 */
async function open_dialog() {
  dialog_open.value = true
  await nextTick()
  sync_dialog()
}

/** 把右栏当前渲染结果同步进弹窗（同一份 HTML，比例与布局完全一致） */
function sync_dialog() {
  if (error.value) {
    dialog_error.value = error.value
    dialog_html.value = ''
    return
  }
  if (!html.value) {
    dialog_error.value = '预览尚未生成，请稍候重试'
    dialog_html.value = ''
    return
  }
  dialog_html.value = html.value
  dialog_base_w.value = base_w.value || DEFAULT_W
  dialog_base_h.value = frame_h.value
  // 保持当前缩放模式；适应宽度时按新内容宽度重算
  if (dialog_fit.value) {
    dialog_scale.value = 1
    nextTick(() => dialog_measure())
  }
  dialog_error.value = ''
}

/** 弹窗 iframe 加载完成：按内容实际高度校准，重新计算适应缩放 */
function onDialogFrameLoad() {
  const doc = dialog_frame.value?.contentDocument
  if (!doc?.documentElement) return
  try {
    const h = doc.documentElement.scrollHeight
    if (h && h > 40) dialog_base_h.value = h
    dialog_measure()
  } catch {
    // sandbox 下 DOM 不可读时保持默认尺寸
  }
}

// ---- 弹窗鼠标拖动平移 ----
// 放大后内容超出视口时，按住左键拖动画布平移查看（与滚动条/滚轮并存）。
// iframe 已设 pointer-events: none（预览纯展示），鼠标事件落在画布上，
// 由视口统一接收拖动；文本选择直接禁用即可，无需额外覆盖层。
const zoom_dragging = ref(false)
let zoom_drag_state = null // { startX, startY, scrollLeft, scrollTop }

function zoom_drag_start(e) {
  if (e.button !== 0) return
  const viewport = dialog_viewport.value
  // 只响应画布区域（滚动条/空白处按下保持原生行为，不影响滚动条拖动）
  if (!viewport || !e.target?.closest?.('.zoom-canvas')) return
  // 内容未溢出时没有可拖动的空间
  if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return
  zoom_drag_state = {
    startX: e.clientX,
    startY: e.clientY,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
  }
  zoom_dragging.value = true
  e.preventDefault() // 阻止文本选择
}

function zoom_drag_move(e) {
  if (!zoom_drag_state) return
  const viewport = dialog_viewport.value
  if (!viewport) return
  viewport.scrollLeft = zoom_drag_state.scrollLeft - (e.clientX - zoom_drag_state.startX)
  viewport.scrollTop = zoom_drag_state.scrollTop - (e.clientY - zoom_drag_state.startY)
}

function zoom_drag_end() {
  if (!zoom_drag_state) return
  zoom_drag_state = null
  zoom_dragging.value = false
}

// 打开时监听弹窗容器尺寸变化（窗口/分栏拖拽），关闭时断开并释放大字符串
watch(dialog_open, async (open) => {
  if (open) {
    await nextTick()
    dialog_measure()
    dialog_ro?.disconnect()
    if (dialog_body.value) {
      dialog_ro = new ResizeObserver(() => dialog_measure())
      dialog_ro.observe(dialog_body.value)
    }
  } else {
    dialog_ro?.disconnect()
    dialog_ro = null
    dialog_html.value = ''
    dialog_error.value = ''
  }
})

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

// 切换模板：侧栏重渲染；弹窗打开时由 render() 成功回调同步（见下方）
watch(current, () => {
  render()
})

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
    // 弹窗打开时同步同一份渲染结果（比例与实际渲染一致）
    if (dialog_open.value) sync_dialog()
  } catch (e) {
    if (token !== refresh_token) return
    error.value = e.message || '模板渲染失败'
    html.value = ''
  } finally {
    if (token === refresh_token) loading.value = false
  }
}

let ro = null
let on_window_resize = null
onMounted(() => {
  ro = new ResizeObserver(() => measure())
  if (viewport.value) ro.observe(viewport.value)
  // 兜底：窗口/分栏尺寸变化时也重算（ResizeObserver 观察目标宽度必须随容器变化）
  on_window_resize = () => measure()
  window.addEventListener('resize', on_window_resize)
  // 弹窗拖拽平移：move/up 挂全局，保证鼠标移出视口后仍能跟上
  window.addEventListener('mousemove', zoom_drag_move)
  window.addEventListener('mouseup', zoom_drag_end)
  measure()
  loadNames().then(() => render()).catch(() => {})
})

onUnmounted(() => {
  ro?.disconnect()
  dialog_ro?.disconnect()
  if (on_window_resize) window.removeEventListener('resize', on_window_resize)
  window.removeEventListener('mousemove', zoom_drag_move)
  window.removeEventListener('mouseup', zoom_drag_end)
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

    <!-- viewport 始终渲染，ResizeObserver 才能可靠观察到宽度变化（右栏拖拽时自适应） -->
    <div ref="viewport" class="preview-viewport">
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

      <div v-else class="preview-canvas" :style="canvas_style">
        <iframe
          ref="frame"
          :srcdoc="html"
          :style="frame_style"
          title="模板预览"
          sandbox="allow-same-origin"
          @load="onFrameLoad"
        />
        <!-- 点击整片预览打开放大弹窗（iframe 会吞掉自身区域的点击，用覆盖层接管） -->
        <button
          type="button"
          class="preview-tap"
          title="点击放大查看"
          aria-label="点击放大查看"
          @click="open_dialog"
        >
          <span class="preview-tap-chip">
            <Icon icon="lucide:zoom-in" width="14" />
            放大查看
          </span>
        </button>
      </div>
    </div>

    <p class="preview-note">点击预览图放大查看；预览使用内置测试数据渲染，实际以 UniBot 运行时的数据为准。</p>

    <Dialog
      v-model="dialog_open"
      title="模板预览（放大）"
      :hide-footer="true"
      width="min(800px, calc(100vw - 32px))"
    >
      <div class="zoom-toolbar">
        <span class="zoom-template" :title="current">{{ current || '—' }}</span>
        <div class="zoom-controls">
          <button
            type="button"
            class="zoom-btn"
            title="缩小"
            aria-label="缩小"
            @click="dialog_zoom(1 / 1.25)"
          >
            <Icon icon="lucide:minus" width="14" />
          </button>
          <button
            type="button"
            class="zoom-btn zoom-label"
            :title="dialog_fit ? '适应宽度' : '100% 原始尺寸'"
            @click="dialog_zoom_100"
          >
            {{ dialog_zoom_label }}
          </button>
          <button
            type="button"
            class="zoom-btn"
            title="放大"
            aria-label="放大"
            @click="dialog_zoom(1.25)"
          >
            <Icon icon="lucide:plus" width="14" />
          </button>
          <button
            type="button"
            class="zoom-btn"
            :class="{ active: dialog_fit }"
            title="适应宽度"
            aria-label="适应宽度"
            @click="dialog_fit_width"
          >
            <Icon icon="lucide:maximize" width="14" />
          </button>
        </div>
        <button
          type="button"
          class="zoom-btn zoom-close"
          title="关闭"
          aria-label="关闭"
          @click="dialog_open = false"
        >
          <Icon icon="lucide:x" width="14" />
        </button>
      </div>

      <div ref="dialog_body" class="zoom-body">
        <div v-if="dialog_error" class="zoom-state danger">
          <Icon icon="lucide:alert-triangle" width="15" />
          <span>{{ dialog_error }}</span>
        </div>
        <div v-else ref="dialog_viewport" class="zoom-viewport" :class="{ dragging: zoom_dragging }" @mousedown="zoom_drag_start">
          <div class="zoom-canvas" :style="dialog_canvas_style">
            <iframe
              ref="dialog_frame"
              :srcdoc="dialog_html"
              :style="dialog_frame_style"
              title="模板预览（放大）"
              sandbox="allow-same-origin"
              @load="onDialogFrameLoad"
            />
          </div>
        </div>
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  width: 100%; /* 跟随右栏容器宽度，右栏拖拽时自适应 */
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

/* 点击放大覆盖层：整片画布可点击，右上角常驻提示 */
.preview-tap {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: var(--space-2);
  background: transparent;
  border: none;
  cursor: zoom-in;
}

.preview-tap-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius);
  background: rgb(15 20 25 / 0.55);
  border: 1px solid rgb(255 255 255 / 0.18);
  color: #e4e4e7;
  font-size: 11px;
  opacity: 0.7;
  transition: opacity 150ms ease-out;
  pointer-events: none;
}

.preview-tap:hover .preview-tap-chip {
  opacity: 1;
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

/* ===== 放大弹窗 ===== */
.zoom-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.zoom-template {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.zoom-controls {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
}

.zoom-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  min-width: 26px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  transition:
    border-color 150ms ease-out,
    color 150ms ease-out,
    background-color 150ms ease-out;
}

.zoom-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.zoom-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}

.zoom-label {
  min-width: 56px;
  font-variant-numeric: tabular-nums;
}

.zoom-body {
  min-width: 0;
}

.zoom-state {
  height: calc(85vh - 170px);
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  padding: var(--space-4);
  text-align: center;
}

.zoom-state.danger {
  color: var(--danger);
}

.zoom-viewport {
  height: calc(85vh - 170px);
  min-height: 300px;
  overflow: auto;
  /* 无深色衬底与内边距：预览内容直接落在弹窗浅色表面，不出现黑边 */
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  /* 拖动平移不需要文本选择，直接禁用 */
  user-select: none;
}

.zoom-viewport.dragging {
  cursor: grabbing;
}

.zoom-canvas {
  position: relative;
  /* 模板页面自带背景，容器不再提供深色衬底 */
  background: transparent;
  cursor: grab; /* 画布区域提示可拖动，内容未溢出时拖动无效果 */
}

.zoom-canvas iframe {
  display: block;
  border: none;
  transform-origin: 0 0;
  background: transparent;
  /* 预览纯展示无交互：鼠标事件穿透到画布/视口，供拖动平移 */
  pointer-events: none;
}
</style>