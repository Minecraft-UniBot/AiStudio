// 根组件：ConfigProvider + 布局骨架 + 路由出口 + 全局事件连接与 toast 容器
<script setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ConfigProvider } from 'reka-ui'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { getToken } from '@/utils/api'
import { use_studio_events } from '@/composables/use_studio_events'
import { use_toast } from '@/composables/use_toast'

const route = useRoute()
const store = useStudioStore()
const { start, stop } = use_studio_events()
const { toast_list, dismiss_toast, pause_toast, resume_toast } = use_toast()

// ---- 主题初始化（亮色 / 暗色 / 跟随系统） ----
const THEME_KEY = 'studio_theme'

function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.dataset.theme = 'dark'
  } else if (theme === 'light') {
    delete root.dataset.theme
  } else {
    // 跟随系统
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.dataset.theme = 'dark'
    } else {
      delete root.dataset.theme
    }
  }
}

// 导出主题设置方法供其他组件使用（如 AdminView 设置页）
window.__studio_setTheme = (theme) => {
  localStorage.setItem(THEME_KEY, theme)
  applyTheme(theme)
}

window.__studio_getTheme = () => localStorage.getItem(THEME_KEY) ?? 'system'

// 初始化：同步读取并应用（避免闪烁）
applyTheme(localStorage.getItem(THEME_KEY) ?? 'system')

// 监听系统主题变化（仅在跟随系统模式下生效）
const mq = window.matchMedia('(prefers-color-scheme: dark)')
function onSystemThemeChange() {
  if ((localStorage.getItem(THEME_KEY) ?? 'system') === 'system') {
    applyTheme('system')
  }
}
mq.addEventListener('change', onSystemThemeChange)

// 事件连接跟随登录状态：登录后（有 token）连接，登出后断开。
// 不能只在 mount 时连接一次——登录发生在 LoginView，路由跳转后
// LoginView 的 use_studio_events 会 stop，这里统一接管。
watch(
  () => route.fullPath,
  () => {
    if (getToken()) {
      store.fetchStatus()
      start()
    } else {
      stop()
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  stop()
  mq.removeEventListener('change', onSystemThemeChange)
})
</script>

<template>
  <ConfigProvider>
    <div class="app-shell">
      <RouterView />
      <!-- 全局轻提示（Plan 9.5：alert/confirm 一律改用 toast） -->
      <div class="toast-container" role="status" aria-live="polite">
        <TransitionGroup name="toast">
          <div
            v-for="toast in toast_list"
            :key="toast.id"
            class="toast-item"
            :class="toast.type"
            @mouseenter="pause_toast(toast.id)"
            @mouseleave="resume_toast(toast.id)"
          >
            <span class="toast-icon-wrap">
              <Icon
                :icon="toast.type === 'success' ? 'lucide:check' : toast.type === 'error' ? 'lucide:alert-circle' : 'lucide:info'"
                width="14"
              />
            </span>
            <span class="toast-message">{{ toast.message }}</span>
            <button class="toast-close" title="关闭" @click="dismiss_toast(toast.id)">
              <Icon icon="lucide:x" width="13" />
            </button>
            <span
              v-if="toast.duration > 0"
              class="toast-progress"
              :style="{ animationDuration: `${toast.duration}ms` }"
            />
          </div>
        </TransitionGroup>
      </div>
    </div>
  </ConfigProvider>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  /* 等宽堆叠：所有 toast 撑满同一宽度，短消息不会收缩，视觉整齐 */
  width: min(380px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  z-index: var(--z-tooltip);
  pointer-events: none;
}

.toast-item {
  position: relative;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: 12px 14px;
  background: rgb(255 255 255 / 0.95);
  backdrop-filter: blur(12px);
  border: 1px solid rgb(228 228 231 / 0.9);
  border-radius: var(--radius-lg);
  box-shadow:
    0 2px 6px rgb(0 0 0 / 0.05),
    0 8px 24px rgb(0 0 0 / 0.08);
  font-size: var(--text-sm);
  overflow: hidden;
}

.toast-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  flex-shrink: 0;
}

.toast-item.success .toast-icon-wrap {
  background: var(--success-soft);
  color: var(--success);
}

.toast-item.error .toast-icon-wrap {
  background: var(--danger-soft);
  color: var(--danger);
}

.toast-item.info .toast-icon-wrap {
  background: var(--accent-soft);
  color: var(--accent);
}

.toast-message {
  flex: 1;
  min-width: 0;
  color: var(--text);
  font-size: var(--text-sm);
  line-height: 1.5;
  word-break: break-word;
}

.toast-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  opacity: 0;
  transition:
    opacity var(--transition),
    background-color var(--transition),
    color var(--transition);
}

.toast-item:hover .toast-close {
  opacity: 1;
}

.toast-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 倒计时进度条：随 toast 生命周期从满到空，悬停时暂停 */
.toast-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left;
  opacity: 0.85;
  animation-name: toast-progress;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

.toast-item.success .toast-progress {
  background: var(--success);
}

.toast-item.error .toast-progress {
  background: var(--danger);
}

.toast-item.info .toast-progress {
  background: var(--accent);
}

.toast-item:hover .toast-progress {
  animation-play-state: paused;
}

@keyframes toast-progress {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

.toast-enter-active {
  transition:
    opacity 260ms ease-out,
    transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}

.toast-leave-active {
  transition:
    opacity 160ms ease-in,
    transform 160ms ease-in;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(calc(100% + 16px)) scale(0.97);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(24px) scale(0.97);
}
</style>

<!-- 暗色模式 toast 适配（非 scoped，覆盖内联硬编码色值） -->
<style>
[data-theme="dark"] .toast-item {
  background: rgb(24 24 27 / 0.95);
  border-color: rgb(63 63 70 / 0.9);
}
</style>

