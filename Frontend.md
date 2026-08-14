# WebUi 代码规范

> 技术栈：Vue 3（组合式 API）· Pinia · Vue Router · Reka UI · Iconify · Vite · Bun
> 风格取向：现代、克制、低圆角、弱渐变。

---

## 1. 项目结构

```
src/
├── main.js              # 入口：挂载应用、注册 pinia / router、引入全局样式
├── App.vue              # 根组件：只放布局骨架与 <RouterView>
├── router/index.js      # 路由配置（统一在此维护）
├── stores/              # Pinia store，一个文件一个 store
├── components/
│   └── ui/              # 基于 reka-ui 的二次封装（Button.vue、Dialog.vue…）
├── views/               # 页面级组件，与路由一一对应
├── composables/         # 可复用逻辑，use_ 前缀（use_xxx.js）
├── styles/
│   └── main.css         # 全局 reset、设计变量、通用工具类
└── utils/               # 纯函数工具
```

约定：

- 组件、composable、store 文件：组件 `PascalCase`，composable / store 用 `snake_case`（`ServerCard.vue`、`use_bot_status.js`、`server.js`）。
- 目录内文件职责单一；单文件超过 ~300 行即考虑拆分。
- 路径引用使用 `@/` 别名，禁止 `../../` 深层相对路径。

## 2. Vue 编码规范

- **只使用组合式 API**：`<script setup>`，禁止 Options API。
- SFC 内块顺序固定：`<script setup>` → `<template>` → `<style scoped>`。
- 显式声明并校验 props / emits：

```vue
<script setup>
defineProps({
  title: { type: String, required: true },
  loading: { type: Boolean, default: false },
})
defineEmits(['confirm'])
</script>
```

- 响应式：对象/数组用 `reactive`，单值用 `ref`；解构 reactive 必须 `toRefs`。
- 副作用一律在 `watchEffect` / `watch` 中处理，并在 `onUnmounted` 清理定时器、监听器。
- 可复用逻辑抽成 `composables/use_xxx.js`，返回响应式数据与方法。
- 模板中不写复杂表达式，超过一行的逻辑移入计算属性或方法。
- 列表渲染必须绑定稳定 `key`（用 id，禁止用 index）。

## 3. Pinia

- 只使用 Setup Store 写法：

```js
// stores/server.js
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export const useServerStore = defineStore('server', () => {
  const list = ref([])
  const online = computed(() => list.value.filter((s) => s.is_online))

  async function fetch_list() {
    /* ... */
  }

  return { list, online, fetch_list }
})
```

- store 函数名沿用 Pinia 官方约定 `useXxxStore`（驼峰），属约定俗成例外；store 内部的 state / action / getter 仍遵循全局 snake_case。

- 状态只在 store 内修改，组件通过 action 触发变更。
- 组件中用 `storeToRefs()` 解构 state / getter，action 直接解构。

## 4. Router

- 路由集中定义于 `router/index.js`，`name` 与视图文件同名。
- 页面级视图使用懒加载：`component: () => import('@/views/HomeView.vue')`。
- 路由守卫只做权限、全局 loading 等横切逻辑。

## 5. UI 框架：Reka UI

- reka-ui 是无样式组件，**禁止在业务代码中直接使用原始 reka-ui 组件**。
- 所有用到的 reka-ui 组件先在 `components/ui/` 中二次封装，再供页面使用：

```vue
<!-- components/ui/Dialog.vue -->
<script setup>
import { DialogRoot, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle } from 'reka-ui'
</script>
```

- 组件的全部样式（包括 reka-ui 相关）直接写在组件自身的 `<style scoped>` 中，不再维护独立的全局 ui.css。
- 充分利用 reka-ui 暴露的 data 状态属性写样式，不额外维护 class：
  `[data-state="open"]`、`[data-state="checked"]`、`[data-highlighted]`、`[data-disabled]`。
- 弹层类组件保留 `DialogPortal` / `PopoverPortal` 默认 portal 行为，不手动挪 DOM。
- 在 `App.vue` 根部包裹 `<ConfigProvider>` 统一全局配置。

## 6. 图标：Iconify

- 统一使用 `@iconify/vue` 的 `<Icon>` 组件，禁止混用其他图标方案：

```vue
<script setup>
import { Icon } from '@iconify/vue'
</script>

<template>
  <Icon icon="lucide:settings" width="16" />
</template>
```

- 图标集统一使用 `lucide`（需要其他集合时在本规范中登记）。
- 尺寸走 `width` / `height`（默认 16 / 20 / 24 三档），颜色继承 `currentColor`。

## 7. 样式规范

### 设计基调

现代、扁平、克制：

- **圆角**：默认 `--radius: 6px`；按钮/输入框 6px，卡片 8px，弹层 10px。禁止全面 16px+ 大圆角，胶囊形仅用于标签、开关等语义场景。
- **渐变**：少用。禁止强对比、高饱和渐变；确需使用时，同色系明度微调（差值 ≤ 10%），且只用于背景，不用于文字。
- 优先用边框（1px）、层级背景色、投影区分层次，而非色彩堆叠。
- 动效：过渡 `150–200ms`，缓动 `ease-out`；只做状态反馈（hover / open / active），不做装饰性动画。

### 设计变量（`styles/main.css`）

颜色、圆角、间距、字号、阴影一律走 CSS 变量，禁止在组件中写魔法值：

```css
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --border: #e4e4e7;
  --text: #18181b;
  --text-muted: #71717a;
  --accent: #2563eb;

  --radius: 6px;
  --radius-lg: 10px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.06);
}
```

### 书写规则

- 组件样式必须 `scoped`；全局样式只允许出现在 `styles/` 目录。
- 选择器最多 3 层嵌套；不使用 `!important`（覆盖第三方样式除外，需注释说明）。
- 布局用 Flex / Grid；间距只用 `--space-*` 变量。
- 类名语义化小写中划线（`server-card`、`status-dot`），不加 `__元素名` 后缀；样式作用域由 `scoped` 保证，无需 BEM 长命名。

## 8. 命名与通用

- 变量/函数 `snake_case`（`server_list`、`fetch_status`），常量 `UPPER_SNAKE`，组件 `PascalCase`。
- **少用缩写**：命名用完整、语义明确的单词，禁止自造缩写（`server_list` ✗ `srv_lst`、`message` ✗ `msg`、`button` ✗ `btn`）；仅允许业界公认缩写（`id`、`url`、`api`、`http`、`ws`）。
- 事件命名 `kebab-case`（`@status-change`）。
- 包管理与脚本统一使用 Bun；提交前执行 `bun run format`（oxfmt）。
- 新增依赖、新增全局样式、新增图标集，需同步更新本文件。

## 9. 参考文档

### Reka UI（https://reka-ui.com/llms.txt）

无样式、完全可访问的 Vue UI 组件库官方文档索引。涉及本项目的 reka-ui 封装时，先获取该文档确认组件 API 与用法。

- **Guides**：`/docs/guides/styling.md`（无样式 + 任意样式方案）、`/docs/guides/animation.md`（CSS keyframes / Vue Transition 动画）、`/docs/guides/composition.md`（`asChild` 组合）、`/docs/guides/controlled-state.md`（受控/非受控状态）、`/docs/guides/server-side-rendering.md`、`/docs/guides/namespaced-components.md`、`/docs/guides/dates.md`、`/docs/guides/i18n.md`（RTL）、`/docs/guides/inject-context.md`（`injectContext`）、`/docs/guides/virtualization.md`（`@tanstack/virtual`）、`/docs/guides/migration.md`（Radix Vue → Reka UI）。
- **Components**：
  - Form：`autocomplete`、`checkbox`、`combobox`、`editable`、`listbox`、`number-field`、`label`、`pin-input`、`radio-group`、`rating`、`select`、`slider`、`switch`、`tags-input`、`toggle`、`toggle-group`
  - Color：`color-area`、`color-field`、`color-slider`、`color-swatch`、`color-swatch-picker`
  - Dates：`calendar`、`date-field`、`date-picker`、`date-range-field`、`date-range-picker`、`range-calendar`、`time-field`、`time-range-field`、`month-picker`、`month-range-picker`、`year-picker`、`year-range-picker`
  - General：`accordion`、`alert-dialog`、`aspect-ratio`、`avatar`、`collapsible`、`context-menu`、`dialog`、`drawer`、`dropdown-menu`、`hover-card`、`menubar`、`navigation-menu`、`pagination`、`popover`、`progress`、`scroll-area`、`separator`、`splitter`、`stepper`、`tabs`、`toast`、`toolbar`、`tooltip`、`tree`
  - 路径格式：`/docs/components/<name>.md`
- **Utilities**：
  - Component：`config-provider`、`focus-scope`、`presence`、`primitive`、`roving-focus`、`slot`、`visually-hidden`
  - Composable：`use-id`、`use-date-formatter`、`use-direction`、`use-locale`、`use-emit-as-props`、`use-filter`、`use-forward-expose`、`use-forward-props`、`use-forward-props-emits`
  - 路径格式：`/docs/utilities/<name>.md`
