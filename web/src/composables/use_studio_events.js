/**
 * Studio 实时事件订阅（Plan 9.5.1 composables/use_studio_events.js）
 *
 * 职责：
 * - 建立/断开到后端的 WebSocket 事件连接
 * - 把归一化事件分发到 store 的状态刷新动作
 * - 断线重连成功后先通过 REST 恢复状态，再继续消费实时事件（Plan 5.3）
 */
import { onUnmounted } from 'vue'
import { connectEvents } from '@/utils/api'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'

export function use_studio_events() {
  const store = useStudioStore()
  const toast = use_toast()
  let disconnect = null

  /** 文件树实时刷新：文件可能发生变化的实时事件都重新拉取文件列表
   * （WorkspaceView 对 store.files 做响应式映射，无需在这里改树结构） */
  function refresh_files(draft_id) {
    store.fetchFiles(draft_id).catch(() => {})
  }

  /**
   * 消息刷新合并（trailing debounce）：
   * 流式阶段 message.updated / message.part.updated 高频到达，每次都全量拉取
   * 会产生大量并发请求（配合 store 的请求序号守卫保证不丢内容，这里再降频）。
   * 终态事件（会话结束 / 状态流转 / 审查 / 校验）立即刷新，保证最终快照落在最后。
   */
  let message_timer = null
  function schedule_messages_refresh(draft_id, immediate = false) {
    clearTimeout(message_timer)
    if (immediate) {
      store.refreshMessages(draft_id)
      return
    }
    message_timer = setTimeout(() => store.refreshMessages(draft_id), 200)
  }

  /** 处理归一化事件：按类型刷新 store 状态 */
  function handle_event(event) {
    // 注意：Pinia setup store 返回的 ref 在 store 实例上自动解包，
    // store.currentDraft 直接就是草稿对象，不能再访问 .value
    const isCurrent = event.draft_id && store.currentDraft?.id === event.draft_id
    if (isCurrent) {
      switch (event.type) {
        case 'session.status':
        case 'session.idle':
        case 'session.error':
        case 'draft.updated':
        case 'draft.published':
          store.refreshCurrent(event.draft_id)
          // 会话结束 / 状态流转后文件可能已变化（如编码完成、审查后校验）
          refresh_files(event.draft_id)
          // 终态事件：立即拉一次消息，确保流式阶段最后一段内容落在最新快照上
          schedule_messages_refresh(event.draft_id, true)
          break
        case 'message.updated':
        case 'message.part.updated':
          // 流式事件：合并刷新，避免请求风暴
          schedule_messages_refresh(event.draft_id)
          break
        case 'session.diff':
          store.fetchDiff(event.draft_id)
          // AI 每次落盘文件都会触发 diff 事件，实时刷新文件树
          refresh_files(event.draft_id)
          break
        case 'todo.updated':
          store.fetchTodo(event.draft_id)
          break
        case 'permission.asked':
          store.pushPendingPermission(event.permission)
          break
        case 'permission.replied':
          store.removePendingPermission(event.permission_id)
          break
        case 'permission.auto_granted':
          // 后端已自动放行白名单文档读取，不弹权限框，仅提示
          if (event.permission?.id) {
            store.removePendingPermission(event.permission.id)
          }
          if (event.permission?.description) {
            toast.info(`已自动允许读取文档：${event.permission.description}`)
          }
          break
        case 'question.asked':
          store.pushPendingQuestion(event.question)
          break
        case 'question.replied':
        case 'question.rejected':
          store.removePendingQuestion(event.question_id)
          break
        case 'validation.updated':
          // 机械校验完成（自动/手动）：刷新草稿（校验结果与状态流转）
          store.refreshCurrent(event.draft_id)
          break
        default:
          break
      }
    }
    if (event.type === 'review.updated' && event.draft_id === store.currentDraft?.id) {
      store.refreshCurrent(event.draft_id)
    }
    // 测试环境同步进度（非草稿级事件）：刷新平台状态
    if (event.type === 'unibot-env.updated') {
      store.fetchStatus()
    }
  }

  /** 建立事件连接（幂等） */
  function start() {
    stop()
    disconnect = connectEvents(handle_event, {
      onOpen: () => {
        store.connected = true
      },
      onClose: () => {
        store.connected = false
      },
      // Plan 5.3：重连后先 REST 恢复，再继续实时事件
      onReconnect: () => store.restoreAfterReconnect(),
    })
  }

  function stop() {
    clearTimeout(message_timer)
    disconnect?.()
    disconnect = null
    store.connected = false
  }

  onUnmounted(stop)

  return { start, stop }
}
