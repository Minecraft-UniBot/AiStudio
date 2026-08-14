<script setup>
// 可拖拽分栏（Plan 3.2：左栏约 240px、右栏约 42%，均可折叠）
// reka-ui 无对应封装，这里用原生 pointer 事件实现拖拽调整宽度
import { ref } from 'vue'

const props = defineProps({
  /** left | right：拖拽方向（右栏向左拖变宽） */
  side: { type: String, default: 'left' },
  defaultWidth: { type: Number, default: 260 },
  minWidth: { type: Number, default: 200 },
  maxWidth: { type: Number, default: 560 },
  collapsed: { type: Boolean, default: false },
})

const emit = defineEmits(['update:collapsed'])

const width = ref(props.defaultWidth)
let dragging = false
let startX = 0
let startWidth = 0

function startDrag(event) {
  dragging = true
  startX = event.clientX
  startWidth = width.value
  window.addEventListener('pointermove', onDrag)
  window.addEventListener('pointerup', endDrag)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onDrag(event) {
  if (!dragging) return
  const dx = props.side === 'left' ? event.clientX - startX : startX - event.clientX
  width.value = Math.min(props.maxWidth, Math.max(props.minWidth, startWidth + dx))
}

function endDrag() {
  dragging = false
  window.removeEventListener('pointermove', onDrag)
  window.removeEventListener('pointerup', endDrag)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}
</script>

<template>
  <aside
    class="resizable-panel"
    :class="[{ collapsed }, `side-${side}`]"
    :style="collapsed ? undefined : { width: `${width}px` }"
  >
    <slot />
    <div v-if="!collapsed" class="resize-handle" :title="side === 'left' ? '拖拽调整宽度' : ''" @pointerdown="startDrag" />
  </aside>
</template>

<style scoped>
.resizable-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  flex-shrink: 0;
  min-height: 0;
}

.resizable-panel.collapsed {
  display: none;
}

.resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 5;
  transition: background-color var(--transition);
}

.side-left .resize-handle {
  right: -2px;
}

.side-right .resize-handle {
  left: -2px;
}

.resize-handle:hover,
.resize-handle:active {
  background: var(--accent);
  opacity: 0.35;
}
</style>
