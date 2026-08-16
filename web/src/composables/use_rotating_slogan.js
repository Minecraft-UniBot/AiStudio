/**
 * 审查/等待期间随机轮换标语（Plan 3.5：等待状态的可读反馈）。
 * 传入激活状态（ref/computed）与标语列表：激活时按固定间隔随机切换
 * 一条标语（不连续重复），停用时清理定时器。
 */
import { ref, computed, watch, onUnmounted } from 'vue'

/** 审查等待标语（审查面板与对话区共用一份，便于统一调整文案） */
export const REVIEW_SLOGANS = [
  '正在核对需求与实现的每一处细节…',
  '正在逐条检查代码规范与命名…',
  '正在验证扩展清单和目录结构…',
  '正在排查潜在的安全风险…',
  '正在检查配置项是否清晰易懂…',
  '正在模拟边界场景与异常处理…',
  '正在确认测试覆盖是否到位…',
  '正在比对规划与实现的一致性…',
  'AI 正在做最后的质检，请稍候…',
]

export function use_rotating_slogan(active, slogans = REVIEW_SLOGANS, interval_ms = 2500) {
  const index = ref(Math.floor(Math.random() * slogans.length))
  const slogan = computed(() => slogans[index.value])
  let timer = null

  watch(
    active,
    (on) => {
      if (on && !timer) {
        timer = setInterval(() => {
          let next
          do {
            next = Math.floor(Math.random() * slogans.length)
          } while (slogans.length > 1 && next === index.value)
          index.value = next
        }, interval_ms)
      } else if (!on && timer) {
        clearInterval(timer)
        timer = null
      }
    },
    { immediate: true },
  )

  onUnmounted(() => {
    if (timer) clearInterval(timer)
    timer = null
  })

  return { slogan }
}
