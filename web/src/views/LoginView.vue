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
        <Icon icon="lucide:box" width="28" />
        <h1>UniBot Extension Studio</h1>
        <p>用自然语言创建、检查、审核并发布 UniBot 扩展</p>
      </div>
      <form class="login-form" @submit.prevent="login">
        <label class="field-label" for="password">访问口令</label>
        <Input
          id="password"
          v-model="password"
          type="password"
          placeholder="请输入平台访问口令"
        />
        <p v-if="errorMsg" class="error">{{ errorMsg }}</p>
        <Button variant="primary" class="login-btn" :loading="loading">
          <Icon icon="lucide:log-in" width="16" />
          {{ loading ? '登录中…' : '进入平台' }}
        </Button>
      </form>
      <p class="hint">口令存储在后端配置（~/.unibot-studio/config/studio.json），首次启动自动生成</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}

.login-card {
  width: 380px;
  padding: 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

.brand {
  text-align: center;
  margin-bottom: 24px;
  color: var(--accent);
}

.brand h1 {
  font-size: 18px;
  margin: 8px 0 4px;
  color: var(--text);
}

.brand p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.field-label {
  display: block;
  font-size: 12.5px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.error {
  color: var(--danger);
  font-size: 12.5px;
  margin: 8px 0 0;
}

.login-btn {
  width: 100%;
  justify-content: center;
  margin-top: 16px;
}

.hint {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.5;
}
</style>
