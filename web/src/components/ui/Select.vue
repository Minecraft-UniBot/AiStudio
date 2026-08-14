<script setup>
import { computed } from 'vue'
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectItem,
  SelectItemText,
} from 'reka-ui'
import { Icon } from '@iconify/vue'

const model = defineModel({ type: String, default: '' })

const props = defineProps({
  options: { type: Array, required: true }, // [{ value, label }]
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
})

// 自行从 options 同步计算展示文本，避免依赖 reka-ui 内部 optionsSet
// 的注册时机导致的「先显示占位符再变回真实值」闪烁。
const selected_label = computed(() => {
  const option = props.options.find((item) => String(item.value) === String(model.value))
  return option ? option.label : ''
})
</script>

<template>
  <SelectRoot v-model="model" :disabled="disabled">
    <SelectTrigger class="ui-select-trigger">
      <SelectValue :placeholder="placeholder">
        {{ selected_label || placeholder }}
      </SelectValue>
      <SelectIcon>
        <Icon icon="lucide:chevron-down" width="14" />
      </SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="ui-select-content" position="popper" :side-offset="4">
        <SelectViewport>
          <SelectItem
            v-for="option in options"
            :key="option.value"
            class="ui-select-item"
            :value="option.value"
          >
            <SelectItemText>{{ option.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<style>
.ui-select-content {
  position: relative;
  min-width: var(--reka-select-trigger-width, 120px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  padding: var(--space-1);
  z-index: var(--z-dropdown);
}
</style>

<style scoped>
.ui-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  height: 34px;
  min-width: 120px;
  padding: 0 var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: var(--text);
  transition: border-color var(--transition);
}

.ui-select-trigger:hover {
  border-color: var(--border-strong);
}

.ui-select-trigger[data-state='open'] {
  border-color: var(--accent);
}

.ui-select-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  transition: background-color var(--transition);
}

.ui-select-item[data-highlighted] {
  background: var(--accent-soft);
  color: var(--accent);
  outline: none;
}

.ui-select-item[data-state='checked'] {
  color: var(--accent);
  font-weight: 500;
}

.ui-select-item[data-disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
