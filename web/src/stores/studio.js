// 全局 store：草稿、会话、消息、校验、审核状态与连接状态
// 事件订阅（连接/断开/重连恢复）见 composables/use_studio_events.js（Plan 9.5.1）
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/utils/api'

// 请求序号守卫：流式事件会高频触发消息/草稿/文件全量拉取，并发请求可能乱序返回。
// 只应用「最后一次发起」的响应，旧快照不得覆盖新状态（否则会丢消息段 / 回退到旧草稿状态）。
const fetch_seq = { draft: 0, messages: 0, files: 0, diff: 0, todo: 0 }

/** 拉取并应用 state，仅当本次请求仍是最新一次发起时写入（乱序旧响应直接丢弃） */
async function guarded_fetch(kind, getter, setter) {
  const seq = ++fetch_seq[kind]
  const data = await getter()
  if (seq === fetch_seq[kind]) setter(data)
  return data
}

export const useStudioStore = defineStore('studio', () => {
  const status = ref(null)
  const drafts = ref([])
  const currentDraft = ref(null)
  const messages = ref([])
  const files = ref([])
  const diff = ref(null)
  const todo = ref([])
  const options = ref({ providers: [], agents: [], test_tools_enabled: true })
  const optionsError = ref('')
  // 自定义 OpenAI 兼容提供商（脱敏后列表，见 server/custom_providers.ts）
  const customProviders = ref([])
  const templates = ref([])
  const templatesError = ref('')
  // 目标 MC 服务器（{ configured, dir, info }；info 为扫描结果快照，见 server/mc_server.ts）
  const mcServer = ref(null)
  const connected = ref(false)
  const error = ref('')
  // 模型自动重试状态（session.status retry 事件）：生成期间流式请求失败时
  // 后端会退避重试，界面据此展示「正在重试」横幅，而不是静默卡住
  const sessionRetry = ref(null)
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
      optionsError.value = ''
    } catch (e) {
      // OpenCode 不可用/获取失败时保留提示，前端不再静默显示空模型列表
      optionsError.value = e.message || '获取模型列表失败'
    }
  }

  // ---- 自定义 OpenAI 兼容提供商（增删会触发后端重启 OpenCode，完成后刷新选项） ----
  async function fetchCustomProviders() {
    customProviders.value = await api('/custom-providers')
    return customProviders.value
  }

  /** 添加提供商（name/base_url/api_key/models?），成功后返回脱敏记录 */
  async function addCustomProvider(input) {
    const created = await api('/custom-providers', { method: 'POST', body: input })
    await Promise.all([fetchCustomProviders(), fetchOptions()])
    return created
  }

  async function removeCustomProvider(id) {
    await api(`/custom-providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await Promise.all([fetchCustomProviders(), fetchOptions()])
  }

  // ---- 开发模板 ----
  async function fetchTemplates() {
    try {
      templates.value = await api('/templates')
      templatesError.value = ''
    } catch (e) {
      templatesError.value = e.message || '获取开发模板失败'
    }
    return templates.value
  }

  /** 触发拉取指定开发模板（Default 等），返回刷新后的模板列表 */
  async function pullTemplate(templateId) {
    await api(`/templates/${encodeURIComponent(templateId)}/pull`, { method: 'POST' })
    return fetchTemplates()
  }

  // ---- 目标 MC 服务器 ----
  async function fetchMcServer() {
    try {
      mcServer.value = await api('/mc-server')
    } catch {
      // 后端异常时保持旧值（未配置时界面按「未选择」处理）
    }
    return mcServer.value
  }

  /** 设置目标服务器目录：后端校验 + 扫描 + 落盘，返回 { configured, dir, info } */
  async function saveMcServer(dir) {
    const data = await api('/mc-server', { method: 'POST', body: { dir } })
    mcServer.value = data
    return data
  }

  /**
   * 弹出后端原生「选择文件夹」窗口：选中后自动扫描并保存；
   * 用户取消返回 { picked: false }（保持原配置），不视为错误。
   */
  async function pickMcServer() {
    const data = await api('/mc-server/pick', { method: 'POST' })
    if (data.picked) mcServer.value = data
    return data
  }

  async function clearMcServer() {
    await api('/mc-server', { method: 'DELETE' })
    mcServer.value = { configured: false, dir: '', info: null }
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
    return guarded_fetch(
      'draft',
      () => api(`/drafts/${id}`),
      (data) => {
        currentDraft.value = data
      },
    )
  }

  async function removeDraft(id) {
    await api(`/drafts/${id}`, { method: 'DELETE' })
    drafts.value = drafts.value.filter((d) => d.id !== id)
  }

  /**
   * 开发途中切换模型（每个草稿仅一次）：model 为 { provider_id, model_id } 或 null（回到自动）。
   * 返回更新后的草稿；后端校验状态与切换次数，失败时抛错。
   */
  async function switchModel(id, model) {
    const draft = await api(`/drafts/${id}/model`, { method: 'POST', body: model })
    if (currentDraft.value?.id === id) currentDraft.value = draft
    const idx = drafts.value.findIndex((d) => d.id === id)
    if (idx >= 0) drafts.value[idx] = draft
    return draft
  }

  // ---- 会话 ----
  async function fetchMessages(id) {
    return guarded_fetch(
      'messages',
      () => api(`/drafts/${id}/messages`),
      (data) => {
        // 过期草稿守卫：切换草稿后，前一个草稿的延迟刷新不得覆盖当前消息列表
        if (currentDraft.value?.id !== id) return
        messages.value = data
      },
    )
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
    return guarded_fetch(
      'diff',
      () => api(`/drafts/${id}/diff`),
      (data) => {
        diff.value = data
      },
    )
  }

  async function fetchTodo(id) {
    return guarded_fetch(
      'todo',
      () => api(`/drafts/${id}/todo`),
      (data) => {
        todo.value = data
      },
    )
  }

  // ---- 文件 ----
  async function fetchFiles(id) {
    return guarded_fetch(
      'files',
      () => api(`/drafts/${id}/files`),
      (data) => {
        files.value = data
      },
    )
  }

  async function fetchFileContent(id, path) {
    const data = await api(`/drafts/${id}/files/content?path=${encodeURIComponent(path)}`)
    return data.content
  }

  // ---- 模板预览 ----
  /** 获取草稿可预览的模板名列表 */
  async function fetchPreviewNames(id) {
    const data = await api(`/drafts/${id}/preview`)
    return (data && data.templates) || []
  }

  /** 渲染指定模板为 HTML，返回 { html, template, templates }；opts 可指定 width/height（放大预览） */
  async function renderPreview(id, template, opts = {}) {
    const body = { template: template || '' }
    if (opts.width) body.width = opts.width
    if (opts.height) body.height = opts.height
    return await api(`/drafts/${id}/preview`, { method: 'POST', body })
  }

  // ---- 校验 / 发布 ----
  /** 让 AI 修复机械校验失败项（后端把失败步骤作为问题单喂给 AI 编码会话） */
  async function debugValidation(id) {
    return await api(`/drafts/${id}/debug`, { method: 'POST', body: { fix_validation: true } })
  }

  /** 手动重新执行机械校验（校验失败修复后 / 测试环境恢复后的重跑入口） */
  async function checkValidation(id) {
    return await api(`/drafts/${id}/check`, { method: 'POST' })
  }

  /** 触发后台同步 UniBot 测试环境（异步，完成后推送 unibot-env.updated） */
  async function syncUnibotEnv() {
    return await api('/unibot-env/sync', { method: 'POST' })
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
    try {
      const before = currentDraft.value?.validation_revision
      await fetchDraft(id)
      // 校验结果或摘要变化时刷新消息与文件
      if (before !== currentDraft.value?.validation_revision) {
        fetchMessages(id).catch(() => {})
        fetchFiles(id).catch(() => {})
      }
    } catch {
      // 刷新失败保持旧状态（后续事件会继续触发刷新）
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
    sessionRetry.value = null
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
    optionsError,
    customProviders,
    templates,
    templatesError,
    connected,
    error,
    sessionRetry,
    pendingPermissions,
    pendingQuestions,
    opencodeAvailable,
    fetchStatus,
    fetchOptions,
    fetchCustomProviders,
    addCustomProvider,
    removeCustomProvider,
    fetchTemplates,
    pullTemplate,
    mcServer,
    fetchMcServer,
    saveMcServer,
    pickMcServer,
    clearMcServer,
    fetchDrafts,
    createDraft,
    fetchDraft,
    removeDraft,
    switchModel,
    fetchMessages,
    sendPrompt,
    abort,
    revertToMessage,
    fetchDiff,
    fetchTodo,
    fetchFiles,
    fetchFileContent,
    fetchPreviewNames,
    renderPreview,
    debugValidation,
    checkValidation,
    syncUnibotEnv,
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
