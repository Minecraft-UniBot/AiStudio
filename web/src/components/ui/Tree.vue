<script setup>
// 通用文件树（Plan 9.5.5：封装到 components/ui/，底层直接使用 reka-ui TreeRoot / TreeItem）
// 用法：nodes: [{ name, path, children: [] }]；点击文件节点触发 select(path)
// 参考：reka-ui /docs/components/tree（flattenItems 模式，见 Plan 9.5.10）
// 键盘导航、ARIA（WAI-ARIA Tree 模式）、聚焦管理由 reka-ui 内置，不再手写递归 DOM。
// 注意：getChildren 对叶子节点必须返回 undefined（而非空数组），否则 reka-ui 会把文件当成文件夹。
import { ref, watch } from 'vue'
import { TreeRoot, TreeItem } from 'reka-ui'
import { Icon } from '@iconify/vue'

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  selected: { type: String, default: '' },
  emptyText: { type: String, default: '加载中…' },
})

const emit = defineEmits(['select'])

/** 收集全部目录 path（用于默认展开） */
function collect_dirs(nodes, acc = []) {
  for (const node of nodes) {
    if (node.children?.length) {
      acc.push(node.path)
      collect_dirs(node.children, acc)
    }
  }
  return acc
}

/** 展开状态：新出现的目录自动展开，用户手动折叠的保持折叠 */
const expanded = ref([])
watch(
  () => props.nodes,
  (nodes) => {
    expanded.value = [...new Set([...expanded.value, ...collect_dirs(nodes)])]
  },
  { immediate: true },
)

/** 点击节点：文件夹仅展开/折叠；文件对外派发 select(path)。
 * 选中高亮由父组件 selected 驱动，因此 preventDefault 掉 reka-ui 内部 modelValue 更新。 */
function on_select(event) {
  const item = event.detail.value
  event.preventDefault()
  if (item.children?.length) return
  emit('select', item.path)
}

/** 文件不参与展开/折叠，避免其 key 进入 expanded */
function on_toggle(event) {
  const item = event.detail.value
  if (!item.children?.length) event.preventDefault()
}
</script>

<template>
  <div class="tree">
    <div v-if="nodes.length === 0" class="tree-empty">{{ emptyText }}</div>
    <TreeRoot
      v-else
      :items="nodes"
      :get-key="(item) => item.path"
      :get-children="(item) => (item.children?.length ? item.children : undefined)"
      :expanded="expanded"
      @update:expanded="(keys) => (expanded = keys)"
      class="tree-root"
    >
      <template #default="{ flattenItems }">
        <TreeItem
          v-for="item in flattenItems"
          :key="item._id"
          v-bind="item.bind"
          @select="on_select"
          @toggle="on_toggle"
          class="tree-item"
        >
          <template #default="{ isExpanded }">
            <div
              class="tree-label"
              :class="{ active: selected === item.value.path, folder: item.hasChildren }"
              :style="{ '--level': item.level }"
            >
              <Icon
                :icon="item.hasChildren ? (isExpanded ? 'lucide:folder-open' : 'lucide:folder') : 'lucide:file-code'"
                width="13"
              />
              <span class="tree-name">{{ item.value.name }}</span>
              <Icon
                v-if="item.hasChildren"
                icon="lucide:chevron-right"
                width="12"
                class="tree-chevron"
                :class="{ rotated: isExpanded }"
              />
            </div>
          </template>
        </TreeItem>
      </template>
    </TreeRoot>
  </div>
</template>

<style scoped>
.tree {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  font-size: 12.5px;
  --indent-step: 14px;
}

.tree-empty {
  padding: 12px;
  color: var(--text-muted);
  font-size: 12.5px;
}

/* TreeRoot 渲染为 ul，TreeItem 渲染为 li，去掉默认列表样式 */
.tree-root {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-item {
  list-style: none;
}

.tree-label {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-top: 3px;
  padding-bottom: 3px;
  padding-right: 6px;
  padding-left: calc(6px + (var(--level, 1) - 1) * var(--indent-step));
  border-radius: 4px;
  cursor: pointer;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
}

.tree-label:hover {
  background: var(--bg-hover);
}

.tree-label.active,
.tree-label.folder.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.tree-label.folder {
  color: var(--text-secondary);
}

.tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-chevron {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 150ms ease-out;
}

.tree-chevron.rotated {
  transform: rotate(90deg);
}
</style>
