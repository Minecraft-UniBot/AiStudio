<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { basicSetup } from 'codemirror'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { StreamLanguage } from '@codemirror/language'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { python } from '@codemirror/legacy-modes/mode/python'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { javascript } from '@codemirror/legacy-modes/mode/javascript'

const props = defineProps({
  modelValue: { type: String, default: '' },
  /** 高亮语言：toml | properties | python | yaml | json | plain */
  language: { type: String, default: 'plain' },
  /** 只读模式（查看文件、Diff 等场景） */
  readonly: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const container = ref(null)
let view = null

function language_ext() {
  switch (props.language) {
    case 'toml':
      return StreamLanguage.define(toml)
    case 'properties':
      return StreamLanguage.define(properties)
    case 'python':
      return StreamLanguage.define(python)
    case 'yaml':
      return StreamLanguage.define(yaml)
    case 'json':
      return StreamLanguage.define(javascript({ json: true }))
    default:
      return []
  }
}

// 匹配项目亮色主题
const custom_theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--surface)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.7',
    padding: '4px 0',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '8px 0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    padding: '0 4px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgb(37 99 235 / 0.04)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    fontWeight: '600',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-md)',
  },
})

function extensions() {
  return [
    basicSetup,
    language_ext(),
    EditorView.lineWrapping,
    props.readonly ? EditorState.readOnly.of(true) : [],
    props.readonly ? EditorView.editable.of(false) : [],
    custom_theme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !props.readonly) emit('update:modelValue', update.state.doc.toString())
    }),
  ]
}

onMounted(() => {
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: extensions(),
  })
  view = new EditorView({ state, parent: container.value })
})

watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  },
)

watch(
  () => props.language,
  () => {
    if (view) {
      view.dispatch({ effects: EditorState.reconfigure.of(extensions()) })
    }
  },
)

watch(
  () => props.readonly,
  () => {
    if (view) {
      view.dispatch({ effects: EditorState.reconfigure.of(extensions()) })
    }
  },
)

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="container" class="code-editor" :class="{ readonly }" />
</template>

<style scoped>
.code-editor {
  height: 100%;
  min-height: 200px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  transition: border-color var(--transition);
}

.code-editor:hover {
  border-color: var(--border-strong);
}

.code-editor.readonly {
  cursor: default;
}

/* 覆盖全局 ::selection 的白字，保证选中文本在浅色高亮下可读 */
.code-editor ::selection {
  background: var(--accent-soft);
  color: var(--text);
}
</style>
