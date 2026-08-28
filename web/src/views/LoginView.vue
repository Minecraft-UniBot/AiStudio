<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api, setToken } from '@/utils/api'
import { useStudioStore } from '@/stores/studio'
import Input from '@/components/ui/Input.vue'
import Button from '@/components/ui/Button.vue'

const router = useRouter()
const store = useStudioStore()
const password = ref('')
const loading = ref(false)
const errorMsg = ref('')

async function login() {
  if (!password.value) {
    errorMsg.value = '请输入访问口令'
    return
  }
  loading.value = true
  errorMsg.value = ''
  try {
    const data = await api('/auth/login', { method: 'POST', body: { password: password.value }, auth: false })
    setToken(data.token)
    store.fetchStatus()
    // 事件连接由 App.vue 按路由/token 统一接管
    router.push('/')
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <div class="brand-icon">
          <Icon icon="lucide:box" width="28" />
        </div>
        <h1>UniBot Extension Studio</h1>
        <p>用自然语言创建、检查、审核并发布 UniBot 扩展</p>
      </div>
      <form class="login-form" @submit.prevent="login">
        <div class="field">
          <label class="field-label" for="password">访问口令</label>
          <Input
            id="password"
            v-model="password"
            type="password"
            placeholder="请输入平台访问口令"
          />
        </div>
        <p v-if="errorMsg" class="error">
          <Icon icon="lucide:alert-circle" width="14" />
          {{ errorMsg }}
        </p>
        <Button variant="primary" class="login-btn" :loading="loading" type="submit">
          <Icon v-if="!loading" icon="lucide:log-in" width="16" />
          {{ loading ? '登录中…' : '进入平台' }}
        </Button>
      </form>
      <p class="hint">
        <Icon icon="lucide:info" width="13" />
        口令存储在后端配置中，首次启动自动生成
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  /* 双层渐变：对角蓝色 + 柔和暖调，营造专业而温暖的第一印象 */
  background:
    radial-gradient(circle at 75% 80%, rgb(239 244 255 / 0.6), transparent 50%),
    radial-gradient(circle at 25% 15%, var(--accent-soft), transparent 50%),
    var(--bg);
}

.login-card {
  width: 380px;
  max-width: 100%;
  padding: 36px 32px 28px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  animation: login-card-enter 280ms cubic-bezier(0.22, 1, 0.36, 1);
}

.brand {
  text-align: center;
  margin-bottom: var(--space-6);
}

.brand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  margin-bottom: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: 0 0 0 4px rgb(37 99 235 / 0.08);
}

.brand h1 {
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0 0 var(--space-1);
  color: var(--text);
}

.brand p {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
  line-height: 1.5;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-secondary);
}

.error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--danger);
  font-size: var(--text-sm);
  margin: 0;
}

.login-btn {
  width: 100%;
  justify-content: center;
  margin-top: var(--space-2);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: var(--space-5) 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: left;
  line-height: 1.5;
}

.hint svg {
  flex-shrink: 0;
  margin-top: 2px;
}

@keyframes login-card-enter {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.98);
  }
}
</style>
