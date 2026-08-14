<script setup>
// 左栏：文件树 + 扩展类型（Plan 3.2）
import { Icon } from '@iconify/vue'
import { TYPE_LABELS } from '@/utils/draft_status'
import Tree from '@/components/ui/Tree.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

defineProps({
  draft: { type: Object, required: true },
  fileTree: { type: Array, default: () => [] },
  selectedFile: { type: String, default: '' },
  emptyText: { type: String, default: '加载中…' },
})

defineEmits(['select-file', 'collapse'])

/** 文件树转嵌套结构 */
function buildTree(paths) {
  const root = []
  const map = new Map()
  for (const path of paths) {
    const parts = path.split('/')
    let level = root
    let key = ''
    for (const part of parts) {
      key = key ? `${key}/${part}` : part
      let node = map.get(key)
      if (!node) {
        node = { name: part, path: key, children: [] }
        map.set(key, node)
        level.push(node)
      }
      level = node.children
    }
  }
  return root
}
</script>

<template>
  <aside class="draft-file-tree">
    <div class="panel-head">
      <div class="panel-head-title">
        <Icon icon="lucide:files" width="14" class="panel-head-icon" />
        <span>草稿文件</span>
      </div>
      <Button variant="ghost" icon-only size="sm" title="折叠" @click="$emit('collapse')">
        <Icon icon="lucide:panel-left-close" width="14" />
      </Button>
    </div>
    <Tree
      :nodes="fileTree"
      :selected="selectedFile"
      :empty-text="emptyText"
      @select="$emit('select-file', $event)"
    />
    <div class="panel-head sub">
      <Icon icon="lucide:tags" width="13" class="panel-head-icon" />
      <span>类型与模型</span>
    </div>
    <div class="type-list">
      <Badge v-for="type in draft.types" :key="type" variant="accent">{{ TYPE_LABELS[type] }}</Badge>
      <Badge v-if="draft.model" variant="neutral">{{ draft.model.model_id }}</Badge>
    </div>
  </aside>
</template>

<style scoped>
.draft-file-tree {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--surface);
}

.panel-head {
  height: 40px;
  padding: 0 var(--space-3);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
  background: var(--surface);
}

.panel-head-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.panel-head-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.panel-head.sub {
  border-bottom: none;
  border-top: 1px solid var(--border);
  height: 34px;
  margin-top: var(--space-1);
  padding-left: var(--space-3);
  gap: var(--space-2);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.type-list {
  padding: var(--space-2) var(--space-3) var(--space-3);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  flex-shrink: 0;
}
</style>
