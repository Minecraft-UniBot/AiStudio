<script setup>
// 大尺寸文件查看器：在文件树中点击文件后以浮层方式展示完整内容，
// 替代原先挤在左栏里的迷你预览（对应反馈：文件展示区域太小）。
import { computed, watch, onBeforeUnmount } from 'vue'
import { Icon } from '@iconify/vue'
import CodeEditor from '@/components/ui/CodeEditor.vue'
import Button from '@/components/ui/Button.vue'

const open = defineModel({ type: Boolean, default: false })

defineProps({
  path: { type: String, default: '' },
  content: { type: String, default: '' },
  size: { type: Number, default: 0 },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['close'])

const title = computed(() => {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
})

const language = computed(() => {
  const name = path.toLowerCase()
  if (name.endsWith('.toml')) return 'toml'
  if (name.endsWith('.properties') || name.endsWith('.ini')) return 'properties'
  if (name.endsWith('.py')) return 'python'
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'yaml'
  if (name.endsWith('.json')) return 'json'
  return 'plain'
})

const sizeText = computed(() => {
  if (!size) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
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
    <div v-if="open" class="file-viewer">
      <div class="file-viewer-backdrop" @click="close" />
      <div class="file-viewer-panel" role="dialog" aria-label="文件预览">
        <header class="file-viewer-head">
          <Icon icon="lucide:file-code" width="16" class="file-viewer-icon" />
          <span class="file-viewer-title mono">{{ title }}</span>
          <span class="file-viewer-path mono">{{ path }}</span>
          <span v-if="sizeText" class="file-viewer-size">{{ sizeText }}</span>
          <span class="file-viewer-spacer" />
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
            <Icon icon="lucide:loader-2" width="18" class="spin" />
            <span>加载文件内容…</span>
          </div>
        </div>
      </div>
    </div>
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
  background: rgb(24 24 27 / 0.5);
  animation: backdrop-fade 150ms ease-out;
}

.file-viewer-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(960px, 94vw);
  height: min(80vh, 88vh);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: panel-in 180ms ease-out;
}

.file-viewer-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  background: var(--surface-sunken);
  flex-shrink: 0;
  min-height: 46px;
}

.file-viewer-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.file-viewer-title {
  font-size: var(--text-sm);
  font-weight: 600;
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

.file-viewer-size {
  font-size: var(--text-xs);
  color: var(--text-muted);
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.file-viewer-spacer {
  flex: 1;
}

.file-viewer-body {
  flex: 1;
  min-height: 0;
  background: var(--surface-sunken);
}

.file-viewer-loading {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes backdrop-fade {
  from {
    opacity: 0;
  }
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
