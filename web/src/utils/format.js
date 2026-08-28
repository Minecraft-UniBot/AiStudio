/**
 * 格式化工具函数（DRY：多组件共用的展示逻辑）
 */

/**
 * 相对时间格式化：几秒前 / 几分钟前 / 几小时前 / 几天前 / 完整日期
 * 统一前端所有 "new Date(x).toLocaleString()" 的展示风格
 */
export function format_relative_time(date_string) {
  if (!date_string) return ''
  const date = new Date(date_string)
  const now = Date.now()
  const diff_ms = now - date.getTime()

  // 未来时间或无效日期直接返回完整格式
  if (diff_ms < 0 || !Number.isFinite(diff_ms)) {
    return date.toLocaleString()
  }

  const seconds = Math.floor(diff_ms / 1000)
  if (seconds < 60) return '刚刚'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`

  // 超过 7 天显示完整日期
  return date.toLocaleDateString()
}
