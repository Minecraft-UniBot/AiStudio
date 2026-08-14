<script setup>
/*
 * 结构化 JSON 表单编辑器
 *
 * 根据后端 Schema 中字段的 `form` 定义渲染人性化表单，替代原始 JSON 文本框。
 * 支持的 kind：
 *   - array : 列表，每个元素由 `fields` 定义的字段对象构成（可增删、可拖动排序）
 *   - map   : 键值对对象，键为字符串，值为 `value_type` 指定类型
 * 字段类型（fields 内）：
 *   - string / text : 文本框
 *   - secret        : 密码框
 *   - number        : 数字框
 *   - boolean       : 开关
 *   - object(kind=booleans) : 一组布尔开关（如 QQ 的 intent）
 *   - object(kind=map)      : 键值对编辑器（如 Discord 的 application_commands）
 */

import { computed, reactive } from 'vue'
import { Icon } from '@iconify/vue'
import Input from './Input.vue'
import Button from './Button.vue'
import Switch from './Switch.vue'
import Collapsible from './Collapsible.vue'

const props = defineProps({
  /** 后端提供的 form 结构 */
  form: { type: Object, required: true },
  /** 当前 JSON 值 */
  modelValue: { type: [Array, Object], default: null },
})

const emit = defineEmits(['update:modelValue'])

const value = computed(() => props.modelValue)

/** 折叠面板展开状态：key = `${item_index}:${field.key}` */
const collapse_open = reactive({})

/** 卡片折叠状态：key = item index。false = 展开；undefined/true = 收起（默认收起） */
const item_collapsed = reactive({})

function toggle_item(index) {
  item_collapsed[index] = item_collapsed[index] === false ? true : false
}

function update(new_value) {
  emit('update:modelValue', new_value)
}

function clone(val) {
  return JSON.parse(JSON.stringify(val ?? null))
}

// ===== array 编辑 =====

function array_items() {
  return Array.isArray(value.value) ? value.value : []
}

function add_array_item() {
  const items = clone(array_items())
  items.push(make_array_item())
  update(items)
}

function make_array_item() {
  const item = {}
  for (const field of props.form.fields || []) {
    item[field.key] = default_value(field)
  }
  return item
}

function remove_array_item(index) {
  const items = clone(array_items())
  items.splice(index, 1)
  update(items)
}

function move_array_item(index, dir) {
  const items = clone(array_items())
  const target = index + dir
  if (target < 0 || target >= items.length) return
  const tmp = items[index]
  items[index] = items[target]
  items[target] = tmp
  update(items)
}

function update_array_field(index, key, field_value) {
  const items = clone(array_items())
  items[index][key] = field_value
  update(items)
}

function array_item_title(item, index) {
  const placeholder = props.form.item_placeholder
  if (placeholder && item) {
    const title = String(item[placeholder] ?? '')
    if (title) return title
  }
  return `${props.form.item_title || '项目'} ${index + 1}`
}

// ===== map 编辑 =====

function map_entries() {
  const obj = value.value
  if (!obj || Array.isArray(obj)) return []
  return Object.entries(obj)
}

function add_map_entry() {
  const entries = clone(map_entries())
  entries.push(['', default_value({ type: props.form.value_type || 'string' })])
  update(Object.fromEntries(entries))
}

function remove_map_entry(index) {
  const entries = clone(map_entries())
  entries.splice(index, 1)
  update(Object.fromEntries(entries))
}

function update_map_key(index, new_key) {
  const entries = clone(map_entries())
  const [, val] = entries[index]
  entries[index] = [new_key, val]
  update(Object.fromEntries(entries))
}

function update_map_value(index, new_value) {
  const entries = clone(map_entries())
  const [key] = entries[index]
  entries[index] = [key, new_value]
  update(Object.fromEntries(entries))
}

// ===== 字段值读写 =====

function default_value(field) {
  switch (field.type) {
    case 'boolean':
      return Boolean(field.default ?? false)
    case 'number':
      return field.default ?? 0
    case 'object':
      if (field.kind === 'booleans') {
        const obj = {}
        for (const bfield of field.fields || []) {
          obj[bfield.key] = Boolean(bfield.default ?? false)
        }
        return obj
      }
      if (field.kind === 'map') return {}
      return {}
    case 'list':
      return []
    default:
      return ''
  }
}

function field_value(item, field) {
  return item[field.key]
}

function update_object_field(item, field, schema_index, key, field_value) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  obj[key] = field_value
  items[schema_index][field.key] = obj
  update(items)
}

function booleans_entries(schema_index, field) {
  const obj = value.value?.[schema_index]?.[field.key] || {}
  return (field.fields || []).map((bfield) => [
    bfield,
    obj[bfield.key] ?? Boolean(bfield.default ?? false),
  ])
}

/** 统计布尔组已开启 / 总数 */
function booleans_count(schema_index, field) {
  const entries = booleans_entries(schema_index, field)
  const opened = entries.filter(([, checked]) => checked).length
  return { opened, total: entries.length }
}

function map_field_entries(schema_index, field) {
  const obj = value.value?.[schema_index]?.[field.key]
  if (!obj || Array.isArray(obj)) return []
  return Object.entries(obj)
}

function update_map_field_key(schema_index, field, index, new_key) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  const [, val] = entries[index]
  entries[index] = [new_key, val]
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}

function update_map_field_value(schema_index, field, index, new_value) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  const [key] = entries[index]
  entries[index] = [key, new_value]
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}

function add_map_field_entry(schema_index, field) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  entries.push(['', default_value({ type: field.value_type || 'string' })])
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}

function remove_map_field_entry(schema_index, field, index) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  entries.splice(index, 1)
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}

function map_value_default(field) {
  return default_value({ type: field.value_type || 'string' })
}

// ===== map 列表值（value_type: list）=====

function map_list_items(value) {
  return Array.isArray(value) ? value : []
}

function update_map_value_list(index, list_index, new_value) {
  const entries = clone(map_entries())
  const [key] = entries[index]
  const list = clone(map_list_items(entries[index][1]))
  list[list_index] = new_value
  entries[index] = [key, list]
  update(Object.fromEntries(entries))
}

function remove_map_value_list_item(index, list_index) {
  const entries = clone(map_entries())
  const [key] = entries[index]
  const list = clone(map_list_items(entries[index][1]))
  list.splice(list_index, 1)
  entries[index] = [key, list]
  update(Object.fromEntries(entries))
}

function add_map_value_list_item(index) {
  const entries = clone(map_entries())
  const [key] = entries[index]
  const list = clone(map_list_items(entries[index][1]))
  list.push('')
  entries[index] = [key, list]
  update(Object.fromEntries(entries))
}

function update_map_field_value_list(schema_index, field, index, list_index, new_value) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  const [key] = entries[index]
  const list = clone(map_list_items(entries[index][1]))
  list[list_index] = new_value
  entries[index] = [key, list]
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}

function remove_map_field_value_list(schema_index, field, index, list_index) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  const [key] = entries[index]
  const list = clone(map_list_items(entries[index][1]))
  list.splice(list_index, 1)
  entries[index] = [key, list]
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}

function add_map_field_value_list(schema_index, field, index) {
  const items = clone(array_items())
  const obj = clone(items[schema_index][field.key] || {})
  const entries = Object.entries(obj)
  const [key] = entries[index]
  const list = clone(map_list_items(entries[index][1]))
  list.push('')
  entries[index] = [key, list]
  items[schema_index][field.key] = Object.fromEntries(entries)
  update(items)
}
</script>

<template>
  <!-- ===== array 编辑器 ===== -->
  <div v-if="form.kind === 'array'" class="jfe jfe--array">
    <div v-for="(item, index) in array_items()" :key="index" class="jfe-item">
      <div
        class="jfe-item__head"
        :class="{ 'jfe-item__head--collapsed': item_collapsed[index] !== false }"
      >
        <button class="jfe-item__title" type="button" @click="toggle_item(index)">
          <Icon
            :icon="item_collapsed[index] ? 'lucide:chevron-down' : 'lucide:chevron-up'"
            width="14"
            class="jfe-item__chevron"
          />
          {{ array_item_title(item, index) }}
        </button>
        <div class="jfe-item__actions">
          <Button
            variant="ghost"
            size="sm"
            icon-only
            :disabled="index === 0"
            title="上移"
            @click="move_array_item(index, -1)"
          >
            <Icon icon="lucide:arrow-up" width="14" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon-only
            :disabled="index === array_items().length - 1"
            title="下移"
            @click="move_array_item(index, 1)"
          >
            <Icon icon="lucide:arrow-down" width="14" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon-only
            title="删除"
            @click="remove_array_item(index)"
          >
            <Icon icon="lucide:trash-2" width="14" />
          </Button>
        </div>
      </div>
      <div v-show="item_collapsed[index] === false" class="jfe-item__body">
        <div
          v-for="field in form.fields || []"
          :key="field.key"
          class="jfe-field"
          :class="{ 'jfe-field--secret': field.type === 'secret' }"
        >
          <div class="jfe-field__label">
            {{ field.label }}
            <span v-if="field.required" class="jfe-required">*</span>
          </div>
          <div class="jfe-field__control">
            <!-- secret -->
            <Input
              v-if="field.type === 'secret'"
              type="password"
              :model-value="field_value(item, field) ?? ''"
              :placeholder="field.placeholder || '留空则不修改'"
              @update:model-value="(v) => update_array_field(index, field.key, v)"
            />
            <!-- number -->
            <Input
              v-else-if="field.type === 'number'"
              type="number"
              :model-value="field_value(item, field) ?? 0"
              @update:model-value="(v) => update_array_field(index, field.key, Number(v))"
            />
            <!-- boolean -->
            <label v-else-if="field.type === 'boolean'" class="jfe-switch">
              <Switch
                :model-value="Boolean(field_value(item, field))"
                @update:model-value="(v) => update_array_field(index, field.key, v)"
              />
              <span class="jfe-switch__text">{{ field_value(item, field) ? '开启' : '关闭' }}</span>
            </label>
            <!-- object: booleans -->
            <Collapsible
              v-else-if="field.type === 'object' && field.kind === 'booleans'"
              :open="collapse_open[`${index}:${field.key}`]"
              @update:open="(v) => (collapse_open[`${index}:${field.key}`] = v)"
            >
              <template #trigger>
                <span class="jfe-collapse__title">{{ field.label }}</span>
                <span class="jfe-collapse__count">
                  已开启 {{ booleans_count(index, field).opened }}/{{
                    booleans_count(index, field).total
                  }}
                </span>
              </template>
              <template #content>
                <div class="jfe-collapse__list">
                  <label
                    v-for="[bfield, bchecked] in booleans_entries(index, field)"
                    :key="bfield.key"
                    class="jfe-boolean"
                    :title="bfield.description"
                  >
                    <Switch
                      :model-value="bchecked"
                      @update:model-value="
                        (v) => update_object_field(item, field, index, bfield.key, v)
                      "
                    />
                    <span class="jfe-boolean__text">{{ bfield.label }}</span>
                  </label>
                </div>
              </template>
            </Collapsible>
            <!-- object: map -->
            <div v-else-if="field.type === 'object' && field.kind === 'map'" class="jfe-map">
              <div
                v-for="(entry, eindex) in map_field_entries(index, field)"
                :key="eindex"
                class="jfe-map__row"
              >
                <Input
                  :model-value="entry[0]"
                  :placeholder="field.key_label"
                  class="jfe-map__key"
                  @update:model-value="(v) => update_map_field_key(index, field, eindex, v)"
                />
                <span class="jfe-map__arrow">→</span>
                <div v-if="field.value_type === 'list'" class="jfe-map__list">
                  <div
                    v-for="(list_item, lindex) in map_list_items(entry[1])"
                    :key="lindex"
                    class="jfe-map__list-row"
                  >
                    <Input
                      :model-value="list_item"
                      :placeholder="field.value_placeholder"
                      @update:model-value="
                        (v) => update_map_field_value_list(index, field, eindex, lindex, v)
                      "
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon-only
                      @click="remove_map_field_value_list(index, field, eindex, lindex)"
                    >
                      <Icon icon="lucide:x" width="14" />
                    </Button>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    @click="add_map_field_value_list(index, field, eindex)"
                  >
                    <Icon icon="lucide:plus" width="13" />
                    添加地址
                  </Button>
                </div>
                <Input
                  v-else
                  :model-value="entry[1]"
                  :placeholder="field.value_placeholder"
                  class="jfe-map__value"
                  @update:model-value="(v) => update_map_field_value(index, field, eindex, v)"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon-only
                  @click="remove_map_field_entry(index, field, eindex)"
                >
                  <Icon icon="lucide:x" width="14" />
                </Button>
              </div>
              <Button variant="secondary" size="sm" @click="add_map_field_entry(index, field)">
                <Icon icon="lucide:plus" width="13" />
                添加条目
              </Button>
            </div>
            <!-- 占位：未支持的字段类型 -->
            <Input
              v-else
              :model-value="field_value(item, field) ?? ''"
              :placeholder="field.placeholder"
              @update:model-value="(v) => update_array_field(index, field.key, v)"
            />
          </div>
        </div>
      </div>
    </div>
    <Button
      variant="secondary"
      size="sm"
      class="jfe-add"
      :class="{ 'jfe-add--empty': array_items().length === 0 }"
      @click="add_array_item"
    >
      <Icon icon="lucide:plus" width="13" />
      添加{{ form.item_title || '项目' }}
    </Button>
  </div>

  <!-- ===== map 编辑器 ===== -->
  <div v-else-if="form.kind === 'map'" class="jfe jfe--map">
    <div v-for="(entry, index) in map_entries()" :key="index" class="jfe-map__row">
      <Input
        :model-value="entry[0]"
        :placeholder="form.key_label"
        class="jfe-map__key"
        @update:model-value="(v) => update_map_key(index, v)"
      />
      <span class="jfe-map__arrow">→</span>
      <div v-if="form.value_type === 'list'" class="jfe-map__list">
        <div
          v-for="(list_item, lindex) in map_list_items(entry[1])"
          :key="lindex"
          class="jfe-map__list-row"
        >
          <Input
            :model-value="list_item"
            :placeholder="form.value_placeholder"
            @update:model-value="(v) => update_map_value_list(index, lindex, v)"
          />
          <Button
            variant="ghost"
            size="sm"
            icon-only
            @click="remove_map_value_list_item(index, lindex)"
          >
            <Icon icon="lucide:x" width="14" />
          </Button>
        </div>
        <Button variant="secondary" size="sm" @click="add_map_value_list_item(index)">
          <Icon icon="lucide:plus" width="13" />
          添加地址
        </Button>
      </div>
      <Input
        v-else
        :model-value="entry[1]"
        :placeholder="form.value_placeholder"
        class="jfe-map__value"
        @update:model-value="(v) => update_map_value(index, v)"
      />
      <Button variant="ghost" size="sm" icon-only @click="remove_map_entry(index)">
        <Icon icon="lucide:x" width="14" />
      </Button>
    </div>
    <Button
      variant="secondary"
      size="sm"
      class="jfe-add"
      :class="{ 'jfe-add--empty': map_entries().length === 0 }"
      @click="add_map_entry"
    >
      <Icon icon="lucide:plus" width="13" />
      添加条目
    </Button>
  </div>
</template>

<style scoped>
.jfe {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
}

.jfe-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-soft);
}

.jfe-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
  transition: border-color var(--transition);
}

.jfe-item__head--collapsed {
  border-bottom: none;
  padding-bottom: 0;
}

.jfe-item__title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
  background: none;
  border: none;
  padding: 2px 4px;
  margin-left: -4px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background-color var(--transition);
}

.jfe-item__title:hover {
  background: var(--surface);
}

.jfe-item__chevron {
  color: var(--text-muted);
  transition: color var(--transition);
}

.jfe-item__title:hover .jfe-item__chevron {
  color: var(--text);
}

.jfe-item__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.jfe-item__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.jfe-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.jfe-field__label {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.jfe-required {
  color: var(--danger);
  margin-left: 2px;
}

.jfe-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.jfe-switch__text {
  font-size: var(--text-sm);
  color: var(--text-muted);
}

/* 折叠面板（事件订阅等布尔组） */
.jfe-collapse__title {
  flex: 1;
  font-weight: 500;
}

.jfe-collapse__count {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  font-weight: 400;
  color: var(--text-muted);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px var(--space-2);
}

.jfe-collapse__list {
  display: flex;
  flex-direction: column;
  max-height: 220px;
  overflow-y: auto;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.jfe-boolean {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius);
  cursor: pointer;
  transition: background-color var(--transition);
}

.jfe-boolean:hover {
  background: var(--surface-soft);
}

.jfe-boolean__text {
  font-size: var(--text-sm);
  color: var(--text);
}

.jfe-map {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.jfe-map__list {
  display: flex;
  flex: 2;
  flex-direction: column;
  gap: var(--space-1);
}

.jfe-map__list-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.jfe-map__list-row .ui-input {
  flex: 1;
}

.jfe-map__row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.jfe-map__key {
  flex: 1;
}

.jfe-map__arrow {
  color: var(--text-muted);
  font-size: var(--text-sm);
  flex: 0 0 auto;
}

.jfe-map__value {
  flex: 2;
}

.jfe-add {
  align-self: flex-start;
}

.jfe-add--empty {
  align-self: center;
  margin: var(--space-1) 0;
}
</style>
