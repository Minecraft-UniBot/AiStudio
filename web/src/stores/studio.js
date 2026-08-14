// 全局 store：草稿、会话、消息、校验、审核状态与连接状态
// 事件订阅（连接/断开/重连恢复）见 composables/use_studio_events.js（Plan 9.5.1）
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/utils/api'

export const useStudioStore = defineStore('studio', () => {
  const status = ref(null)
  const drafts = ref([])
  const currentDraft = ref(null)
  const messages = ref([])
  const files = ref([])
  const diff = ref(null)
  const todo = ref([])
  const options = ref({ providers: [], agents: [], review_enabled: true })
  const connected = ref(false)
  const error = ref('')
  const pendingPermissions = ref([])
  const pendingQuestions = ref([])

  // ---- 状态 ----
  async function fetchStatus() {
    try {
      status.value = await api('/status')
    } catch (e) {
      error.value = e.message
    }
  }

  async function fetchOptions() {
    try {
      options.value = await api('/options')
    } catch {
      // 忽略（OpenCode 不可用时不阻塞）
    }
  }

  // ---- 草稿 ----
  async function fetchDrafts() {
    drafts.value = await api('/drafts')
    return drafts.value
  }

  async function createDraft(input) {
    const data = await api('/drafts', { method: 'POST', body: input })
    return data.draft
  }

  async function fetchDraft(id) {
    currentDraft.value = await api(`/drafts/${id}`)
    return currentDraft.value
  }

  async function removeDraft(id) {
    await api(`/drafts/${id}`, { method: 'DELETE' })
    drafts.value = drafts.value.filter((d) => d.id !== id)
  }

  // ---- 会话 ----
  async function fetchMessages(id) {
    messages.value = await api(`/drafts/${id}/messages`)
    return messages.value
  }

  async function sendPrompt(id, text) {
    await api(`/drafts/${id}/messages`, { method: 'POST', body: { text } })
  }

  async function abort(id) {
    await api(`/drafts/${id}/abort`, { method: 'POST' })
  }

  /** 回退到某条消息之前：OpenCode 恢复文件状态与对话记录，旧校验/审核失效 */
  async function revertToMessage(id, messageId) {
    await api(`/drafts/${id}/revert`, {
      method: 'POST',
      body: { message_id: messageId },
    })
  }

  async function fetchDiff(id) {
    diff.value = await api(`/drafts/${id}/diff`)
    return diff.value
  }

  async function fetchTodo(id) {
    todo.value = await api(`/drafts/${id}/todo`)
    return todo.value
  }

  // ---- 文件 ----
  async function fetchFiles(id) {
    files.value = await api(`/drafts/${id}/files`)
    return files.value
  }

  async function fetchFileContent(id, path) {
    const data = await api(`/drafts/${id}/files/content?path=${encodeURIComponent(path)}`)
    return data.content
  }

  // ---- 校验 / 审核 / 发布 ----
  async function runValidation(id) {
    return await api(`/drafts/${id}/validate`, { method: 'POST' })
  }

  async function startReview(id) {
    return await api(`/drafts/${id}/review`, { method: 'POST' })
  }

  async function fetchReview(id) {
    return await api(`/drafts/${id}/review`)
  }

  async function startDebug(id) {
    return await api(`/drafts/${id}/debug`, { method: 'POST' })
  }

  async function publish(id) {
    return await api(`/drafts/${id}/publish`, { method: 'POST' })
  }

  // ---- 权限 / 问题 ----
  async function replyPermission(id, permissionId, response) {
    await api(`/drafts/${id}/permissions/${permissionId}`, {
      method: 'POST',
      body: { response },
    })
  }

  /**
   * 拉取待处理权限（SSE 事件丢失/断线重连后的兜底：opencode 的 pending 权限
   * 在进程内存里，只要 opencode 未重启就能从这里恢复并补出弹窗）。
   */
  async function fetchPendingPermissions(id) {
    try {
      const perms = await api(`/drafts/${id}/permissions`)
      for (const p of perms) pushPendingPermission(p)
    } catch {
      // OpenCode 不可用时忽略
    }
  }

  /** 回答 AI 提问：answers 为每个问题的回答数组（元素为选项 label 或自定义文本） */
  async function replyQuestion(id, questionId, answers) {
    await api(`/drafts/${id}/questions/${questionId}`, {
      method: 'POST',
      body: { answers },
    })
  }

  /** 忽略 AI 提问（question 工具继续执行但不采纳回答） */
  async function rejectQuestion(id, questionId) {
    await api(`/drafts/${id}/questions/${questionId}/reject`, { method: 'POST' })
  }

  // ---- 状态刷新 ----
  async function refreshCurrent(id) {
    const before = currentDraft.value?.validation_revision
    currentDraft.value = await api(`/drafts/${id}`)
    // 校验结果或摘要变化时刷新消息与文件
    if (before !== currentDraft.value?.validation_revision) {
      fetchMessages(id).catch(() => {})
      fetchFiles(id).catch(() => {})
    }
  }

  async function refreshMessages(id) {
    fetchMessages(id).catch(() => {})
  }

  /**
   * 断线重连后的 REST 恢复（Plan 5.3）：
   * 重新获取 session、messages、todo、diff 与文件树；
   * 待处理授权（permission/question）由实时事件流重新填充。
   */
  async function restoreAfterReconnect() {
    const id = currentDraft.value?.id
    if (!id) return
    await Promise.allSettled([
      fetchDraft(id),
      fetchMessages(id),
      fetchDiff(id),
      fetchTodo(id),
      fetchFiles(id),
      fetchPendingPermissions(id),
    ])
    resetPending()
  }

  // ---- 待处理权限 / 问题 ----
  /** 待处理权限 / 问题（由实时事件填充，切换草稿时清空） */
  function resetPending() {
    pendingPermissions.value = []
    pendingQuestions.value = []
  }

  function pushPendingPermission(permission) {
    if (!permission?.id) return
    if (!pendingPermissions.value.some((p) => p.id === permission.id)) {
      pendingPermissions.value.push(permission)
    }
  }

  function pushPendingQuestion(question) {
    if (!question?.id) return
    if (!pendingQuestions.value.some((q) => q.id === question.id)) {
      pendingQuestions.value.push(question)
    }
  }

  function removePendingPermission(permissionId) {
    pendingPermissions.value = pendingPermissions.value.filter((p) => p.id !== permissionId)
  }

  function removePendingQuestion(questionId) {
    pendingQuestions.value = pendingQuestions.value.filter((q) => q.id !== questionId)
  }

  const opencodeAvailable = computed(() => Boolean(status.value?.available))

  return {
    status,
    drafts,
    currentDraft,
    messages,
    files,
    diff,
    todo,
    options,
    connected,
    error,
    pendingPermissions,
    pendingQuestions,
    opencodeAvailable,
    fetchStatus,
    fetchOptions,
    fetchDrafts,
    createDraft,
    fetchDraft,
    removeDraft,
    fetchMessages,
    sendPrompt,
    abort,
    revertToMessage,
    fetchDiff,
    fetchTodo,
    fetchFiles,
    fetchFileContent,
    runValidation,
    startReview,
    fetchReview,
    startDebug,
    publish,
    replyPermission,
    replyQuestion,
    rejectQuestion,
    fetchPendingPermissions,
    refreshCurrent,
    refreshMessages,
    restoreAfterReconnect,
    resetPending,
    pushPendingPermission,
    pushPendingQuestion,
    removePendingPermission,
    removePendingQuestion,
  }
})
