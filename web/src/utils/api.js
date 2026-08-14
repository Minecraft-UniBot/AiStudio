// API 封装：统一 fetch + token 管理 + WebSocket 事件连接
const TOKEN_KEY = 'studio_token'
// REST 走 vite 代理；WebSocket 直连后端（Bun 下 vite 的 ws 代理有兼容问题）
const WS_BASE = import.meta.env.VITE_STUDIO_WS ?? 'ws://127.0.0.1:9876'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) ?? ''
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) headers['Authorization'] = `Bearer ${getToken()}`
  const res = await fetch(`/api/studio${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data
  try {
    data = await res.json()
  } catch {
    data = { code: 1, data: null, message: '响应解析失败' }
  }
  if (res.status === 401 && auth) {
    clearToken()
    window.location.href = '/login'
    throw new Error('未授权')
  }
  if (data.code !== 0) {
    throw new Error(data.message || '请求失败')
  }
  return data.data
}

// 会话事件（WebSocket，断线自动重连；onReconnect 用于重连后 REST 恢复）
export function connectEvents(onEvent, { onOpen, onClose, onReconnect } = {}) {
  let ws = null
  let retry = 0
  let closed = false

  const connect = () => {
    if (closed) return
    ws = new WebSocket(`${WS_BASE}/api/studio/events?token=${encodeURIComponent(getToken())}`)

    ws.onopen = () => {
      retry = 0
      onOpen?.()
      // 重连成功后触发 REST 恢复（首次连接也触发，保证状态完整）
      if (retry === 0) onReconnect?.()
    }
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data)
        onEvent(event)
      } catch {
        // 忽略无法解析的消息
      }
    }
    ws.onclose = () => {
      onClose?.()
      if (!closed) {
        retry = Math.min(retry + 1, 5)
        setTimeout(connect, 1000 * retry)
      }
    }
    ws.onerror = () => ws?.close()
  }
  connect()

  return () => {
    closed = true
    ws?.close()
  }
}
