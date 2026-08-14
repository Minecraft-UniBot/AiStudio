<script setup>
// 左栏：文件树 + 扩展类型（Plan 3.2）
import { Icon } from '@iconify/vue'
import { TYPE_LABELS } from '@/utils/draft_status'
import Tree from '@/components/ui/Tree.vue'
import Button from '@/components/ui/Button.vue'

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
      <span>草稿文件</span>
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
      <span>类型</span>
    </div>
    <div class="type-list">
      <span v-for="type in draft.types" :key="type" class="type-tag">{{ TYPE_LABELS[type] }}</span>
      <span v-if="draft.model" class="type-tag muted mono">{{ draft.model.model_id }}</span>
    </div>
  </aside>
</template>

<style scoped>
.draft-file-tree {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.panel-head {
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.panel-head.sub {
  border-bottom: none;
  height: 30px;
  margin-top: 6px;
}

.type-list {
  padding: 0 10px 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.type-tag {
  font-size: 11.5px;
  padding: 1px 7px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
}

.type-tag.muted {
  background: var(--surface-sunken);
  color: var(--text-muted);
}
</style>
