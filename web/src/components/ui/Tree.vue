<script setup>
// 通用文件树（Plan 9.5.5：树封装到 components/ui/）
// nodes: [{ name, path, children: [] }]；点击文件节点触发 select(path)
import { Icon } from '@iconify/vue'

defineProps({
  nodes: { type: Array, default: () => [] },
  selected: { type: String, default: '' },
  emptyText: { type: String, default: '加载中…' },
})

defineEmits(['select'])
</script>

<template>
  <div class="tree">
    <div v-if="nodes.length === 0" class="tree-empty">{{ emptyText }}</div>
    <div v-for="node in nodes" :key="node.path" class="tree-node">
      <!-- 文件夹 -->
      <template v-if="node.children?.length">
        <div class="tree-label">
          <Icon icon="lucide:folder" width="13" />
          {{ node.name }}
        </div>
        <div class="tree-children">
          <!-- 递归渲染子节点（key 放在真实元素上） -->
          <template v-for="child in node.children">
            <div v-if="child.children?.length" :key="child.path" class="tree-node">
              <div class="tree-label">
                <Icon icon="lucide:folder" width="13" />
                {{ child.name }}
              </div>
              <div class="tree-children">
                <div
                  v-for="leaf in child.children"
                  :key="leaf.path"
                  class="tree-file"
                  :class="{ active: selected === leaf.path }"
                  @click="$emit('select', leaf.path)"
                >
                  <Icon icon="lucide:file-code" width="13" />
                  {{ leaf.name }}
                </div>
              </div>
            </div>
            <div
              v-else
              :key="child.path"
              class="tree-file"
              :class="{ active: selected === child.path }"
              @click="$emit('select', child.path)"
            >
              <Icon icon="lucide:file-code" width="13" />
              {{ child.name }}
            </div>
          </template>
        </div>
      </template>
      <!-- 顶层文件 -->
      <div
        v-else
        class="tree-file"
        :class="{ active: selected === node.path }"
        @click="$emit('select', node.path)"
      >
        <Icon icon="lucide:file-code" width="13" />
        {{ node.name }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  font-size: 12.5px;
}

.tree-empty {
  padding: 12px;
  color: var(--text-muted);
  font-size: 12.5px;
}

.tree-label {
  padding: 3px 6px;
  color: var(--text-secondary);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

.tree-children {
  padding-left: 14px;
}

.tree-file {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-file:hover {
  background: var(--bg-hover);
}

.tree-file.active {
  background: var(--accent-soft);
  color: var(--accent);
}
</style>
