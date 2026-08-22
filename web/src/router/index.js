import { createRouter, createWebHistory } from 'vue-router'
import { getToken, setToken, clearToken } from '@/utils/api'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'Drafts',
      component: () => import('@/views/DraftsView.vue'),
    },
    {
      path: '/workspace/:id',
      name: 'Workspace',
      component: () => import('@/views/WorkspaceView.vue'),
    },
    {
      path: '/admin',
      name: 'Admin',
      component: () => import('@/views/AdminView.vue'),
    },
  ],
})

router.beforeEach(async (to) => {
  // 地址携带 ?token=xxx（启动横幅打印的登录链接）：直接把该 token 作为登录态。
  // 向后端校验有效性后从地址栏移除参数，避免 token 残留在网址与历史记录中。
  const token = to.query.token
  if (typeof token === 'string' && token) {
    setToken(token)
    let valid = false
    try {
      const res = await fetch('/api/studio/status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      valid = res.ok
    } catch {
      valid = false
    }
    const query = { ...to.query }
    delete query.token
    if (valid) return { path: to.path, query }
    clearToken()
    return { path: '/login', query }
  }
  if (!to.meta.public && !getToken()) {
    return { path: '/login' }
  }
  if (to.path === '/login' && getToken()) {
    return { path: '/' }
  }
})

export default router
