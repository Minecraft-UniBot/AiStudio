import { createRouter, createWebHistory } from 'vue-router'
import { getToken } from '@/utils/api'

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

router.beforeEach((to) => {
  if (!to.meta.public && !getToken()) {
    return { path: '/login' }
  }
  if (to.path === '/login' && getToken()) {
    return { path: '/' }
  }
})

export default router
