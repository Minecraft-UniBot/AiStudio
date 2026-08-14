/**
 * 全局轻提示（Toast）
 * 模块级共享队列，任意组件通过 use_toast() 触发
 * - 记录 duration 供进度条动画使用
 * - 支持 hover 暂停 / 离开继续倒计时（进度条与计时器保持同步）
 */
import { ref } from 'vue'

const toast_list = ref([])
let toast_id = 0
const timers = new Map()

function push_toast(type, message, duration = 3000) {
  const id = ++toast_id
  const item = { id, type, message, duration, remaining: duration, started_at: null }
  toast_list.value.push(item)
  arm_timer(item)
}

function arm_timer(toast) {
  if (toast.remaining <= 0) return
  clearTimeout(timers.get(toast.id))
  timers.set(toast.id, setTimeout(() => dismiss_toast(toast.id), toast.remaining))
}

/** 鼠标悬停：暂停倒计时（进度条由 CSS animation-play-state 同步暂停） */
function pause_toast(id) {
  const toast = toast_list.value.find((t) => t.id === id)
  if (!toast || toast.remaining <= 0) return
  clearTimeout(timers.get(id))
  toast.started_at = Date.now()
}

/** 鼠标移开：恢复倒计时 */
function resume_toast(id) {
  const toast = toast_list.value.find((t) => t.id === id)
  if (!toast) return
  if (toast.started_at != null) {
    toast.remaining -= Date.now() - toast.started_at
    toast.started_at = null
  }
  arm_timer(toast)
}

function dismiss_toast(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  toast_list.value = toast_list.value.filter((toast) => toast.id !== id)
}

export function use_toast() {
  return {
    toast_list,
    dismiss_toast,
    pause_toast,
    resume_toast,
    success: (message) => push_toast('success', message),
    error: (message) => push_toast('error', message, 4500),
    info: (message) => push_toast('info', message),
  }
}
