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

export function use_studio_events() {
  const store = useStudioStore()
  let disconnect = null

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
          break
        case 'message.updated':
        case 'message.part.updated':
          store.refreshMessages(event.draft_id)
          break
        case 'session.diff':
          store.fetchDiff(event.draft_id)
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
        case 'question.asked':
          store.pushPendingQuestion(event.question)
          break
        case 'question.replied':
        case 'question.rejected':
          store.removePendingQuestion(event.question_id)
          break
        default:
          break
      }
    }
    if (event.type === 'validation.updated' && event.draft_id === store.currentDraft?.id) {
      store.refreshCurrent(event.draft_id)
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
    disconnect?.()
    disconnect = null
    store.connected = false
  }

  onUnmounted(stop)

  return { start, stop }
}
