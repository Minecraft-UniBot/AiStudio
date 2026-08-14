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
const { toast_list, dismiss_toast } = use_toast()

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
})
</script>

<template>
  <ConfigProvider>
    <div class="app-shell">
      <RouterView />
      <!-- 全局轻提示（Plan 9.5：alert/confirm 一律改用 toast） -->
      <div class="toast-container" role="status" aria-live="polite">
        <TransitionGroup name="toast">
          <div v-for="toast in toast_list" :key="toast.id" class="toast-item" :class="toast.type">
            <Icon
              :icon="toast.type === 'success' ? 'lucide:check-circle-2' : toast.type === 'error' ? 'lucide:alert-circle' : 'lucide:info'"
              width="15"
            />
            <span class="toast-message">{{ toast.message }}</span>
            <button class="toast-close" title="关闭" @click="dismiss_toast(toast.id)">
              <Icon icon="lucide:x" width="13" />
            </button>
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
  top: 14px;
  right: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: var(--z-tooltip);
  pointer-events: none;
}

.toast-item {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 240px;
  max-width: 380px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: var(--text-sm);
}

.toast-item.success {
  border-color: #bbf7d0;
}

.toast-item.success svg {
  color: var(--success);
}

.toast-item.error {
  border-color: #fecaca;
}

.toast-item.error svg {
  color: var(--danger);
}

.toast-item.info svg {
  color: var(--accent);
}

.toast-message {
  flex: 1;
  color: var(--text);
  line-height: 1.45;
}

.toast-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
}

.toast-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 180ms ease-out,
    transform 180ms ease-out;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>

