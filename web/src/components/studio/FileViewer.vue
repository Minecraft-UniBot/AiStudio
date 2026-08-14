<script setup>
// 大尺寸文件查看器：在文件树中点击文件后以浮层方式展示完整内容，
// 替代原先挤在左栏里的迷你预览（对应反馈：文件展示区域太小）。
import { computed, watch, onBeforeUnmount } from 'vue'
import { Icon } from '@iconify/vue'
import CodeEditor from '@/components/ui/CodeEditor.vue'
import Button from '@/components/ui/Button.vue'

const open = defineModel({ type: Boolean, default: false })

const props = defineProps({
  path: { type: String, default: '' },
  content: { type: String, default: '' },
  size: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

const title = computed(() => {
  const parts = props.path.split('/')
  return parts[parts.length - 1] || props.path
})

const language = computed(() => {
  const name = props.path.toLowerCase()
  if (name.endsWith('.toml')) return 'toml'
  if (name.endsWith('.properties') || name.endsWith('.ini')) return 'properties'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml'
  if (name.endsWith('.json')) return 'json'
  return 'plain'
})

const sizeText = computed(() => {
  if (!props.size) return ''
  if (props.size < 1024) return `${props.size} B`
  if (props.size < 1024 * 1024) return `${(props.size / 1024).toFixed(1)} KB`
  return `${(props.size / 1024 / 1024).toFixed(2)} MB`
})

function onKeydown(event) {
  if (event.key === 'Escape' && open.value) close()
}

function close() {
  open.value = false
  emit('close')
}

watch(open, (value) => {
  if (value) document.addEventListener('keydown', onKeydown)
  else document.removeEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="file-viewer">
      <div v-if="open" class="file-viewer">
        <div class="file-viewer-backdrop" @click="close" />
        <div class="file-viewer-panel" role="dialog" aria-label="文件预览">
          <header class="file-viewer-head">
            <div class="file-viewer-head-left">
              <Icon icon="lucide:file-code" width="16" class="file-viewer-icon" />
              <span class="file-viewer-title mono">{{ title }}</span>
              <span v-if="sizeText" class="file-viewer-size">{{ sizeText }}</span>
            </div>
            <div class="file-viewer-path-wrap" :title="path">
              <Icon icon="lucide:folder" width="12" class="file-viewer-path-icon" />
              <span class="file-viewer-path mono">{{ path }}</span>
            </div>
            <Button variant="ghost" icon-only size="sm" title="关闭 (Esc)" @click="close">
              <Icon icon="lucide:x" width="16" />
            </Button>
          </header>
          <div class="file-viewer-body">
            <CodeEditor
              v-if="!loading && content !== ''"
              :model-value="content"
              :language="language"
              readonly
            />
            <div v-else class="file-viewer-loading">
              <Icon icon="lucide:loader-2" width="20" class="spin" />
              <span>加载文件内容…</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.file-viewer {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
}

.file-viewer-backdrop {
  position: absolute;
  inset: 0;
  background: rgb(24 24 27 / 0.45);
  backdrop-filter: blur(2px);
}

.file-viewer-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(960px, 94vw);
  height: min(82vh, 88vh);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.file-viewer-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  min-height: 48px;
}

.file-viewer-head-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.file-viewer-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.file-viewer-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
}

.file-viewer-size {
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: var(--bg-hover);
  padding: 1px var(--space-2);
  border-radius: 4px;
  flex-shrink: 0;
}

.file-viewer-path-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  padding: 2px var(--space-2);
  background: var(--surface-sunken);
  border-radius: var(--radius);
  overflow: hidden;
}

.file-viewer-path-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.file-viewer-path {
  font-size: var(--text-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.file-viewer-body {
  flex: 1;
  min-height: 0;
  background: var(--surface-sunken);
  padding: var(--space-2);
}

.file-viewer-body :deep(.code-editor) {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.file-viewer-loading {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.spin {
  animation: spin 1s linear infinite;
  color: var(--accent);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Transition */
.file-viewer-enter-active,
.file-viewer-leave-active {
  transition: opacity 180ms ease-out;
}

.file-viewer-enter-active .file-viewer-panel,
.file-viewer-leave-active .file-viewer-panel {
  transition: transform 180ms ease-out, opacity 180ms ease-out;
}

.file-viewer-enter-from,
.file-viewer-leave-to {
  opacity: 0;
}

.file-viewer-enter-from .file-viewer-panel,
.file-viewer-leave-to .file-viewer-panel {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
