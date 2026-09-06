<script setup>
// 上传插件市场对话框：登录态检测 + 步骤进度 + 结果链接
// 流程（后端 studio/market.ts）：precheck → auth → scaffold → commit → repo → push → release → asset → market_pr
// 全部通过 git/gh 命令行驱动；未登录时可在弹窗内一键登录（gh auth login --web 后台执行）
import { onMounted, watch, ref, computed, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import Dialog from '@/components/ui/Dialog.vue'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const open = defineModel({ type: Boolean, default: false })

const props = defineProps({
  draft: { type: Object, required: true },
})

const emit = defineEmits(['started'])

const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const starting = ref(false)

/** 当前上传运行记录（draft.market，随 market.updated 事件实时刷新） */
const run = computed(() => props.draft?.market ?? null)
const running = computed(() => run.value?.status === 'running')

/** 步骤状态对应的图标与样式 */
function stepVisual(status) {
  switch (status) {
    case 'passed':
      return { icon: 'lucide:check-circle-2', cls: 'passed' }
    case 'running':
      return { icon: 'lucide:loader-2', cls: 'running spin' }
    case 'failed':
      return { icon: 'lucide:x-circle', cls: 'failed' }
    default:
      return { icon: 'lucide:circle', cls: 'pending' }
  }
}

/** 未就绪原因 → 是否引导去设置页粘贴 token */
const needsSetup = computed(() =>
  Boolean(store.marketStatus && !store.marketStatus.ready),
)

async function loadStatus() {
  await store.fetchMarketStatus()
}

onMounted(loadStatus)
watch(open, (value) => {
  if (value) loadStatus()
})

/** 开始上传（后台执行，进度经 market.updated 事件推送） */
async function startUpload() {
  starting.value = true
  try {
    const created = await store.startMarketPublish(props.draft.id)
    toast_success('已开始上传插件市场，可在本窗口查看进度')
    emit('started', created)
    await store.fetchDraft(props.draft.id)
  } catch (e) {
    toast_error(e.message)
  } finally {
    starting.value = false
  }
}

/** 安装 GitHub CLI（gh 未安装时从 cli/cli releases 拉取当前系统安装包） */
const installingGh = ref(false)
async function installGh() {
  installingGh.value = true
  try {
    const info = await store.installGhCli()
    if (info.in_path) {
      toast_success(`GitHub CLI 已安装（v${info.version ?? ''}），可重新检测登录态`)
    } else {
      toast_success(`GitHub CLI 已安装到 ${info.bin_path}，请将该目录加入 PATH 后重试`)
    }
    await loadStatus()
  } catch (e) {
    toast_error(e.message)
  } finally {
    installingGh.value = false
  }
}

// ===== GitHub 登录（后台执行 gh auth login --web） =====

/** 登录进行中 / 已获取 one-time code */
const loggingIn = ref(false)
/** 后端返回的登录信息（code + url） */
const loginInfo = ref(null)
/** 登录状态轮询定时器 */
let loginPollTimer = null

/** 一键登录：后端启动 gh auth login --web，返回 one-time code + URL 供展示 */
async function startLogin() {
  loggingIn.value = true
  loginInfo.value = null
  try {
    const info = await store.startGhLogin()
    if (info.pending && info.code) {
      loginInfo.value = info
      toast_success('已生成登录验证码，请在浏览器完成授权')
      // 轮询检测登录态（授权完成后自动刷新）
      startLoginPolling()
    } else {
      toast_success('GitHub 已登录')
      await loadStatus()
    }
  } catch (e) {
    toast_error(e.message)
  } finally {
    loggingIn.value = false
  }
}

/** 轮询登录态：授权完成后停止轮询并刷新状态 */
function startLoginPolling() {
  stopLoginPolling()
  loginPollTimer = setInterval(async () => {
    await loadStatus()
    if (store.marketStatus?.gh_authed) {
      stopLoginPolling()
      loginInfo.value = null
      toast_success('GitHub 登录成功')
    }
  }, 2000)
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer)
    loginPollTimer = null
  }
}

/** 取消登录（关闭弹窗/放弃时调用） */
async function cancelLogin() {
  stopLoginPolling()
  loginInfo.value = null
  try {
    await store.cancelGhLogin()
  } catch {
    // 取消失败不影响关闭
  }
}

/** 复制一次性验证码到剪贴板 */
async function copyLoginCode() {
  try {
    await navigator.clipboard.writeText(loginInfo.value?.code ?? '')
    toast_success('验证码已复制')
  } catch {
    toast_error('复制失败，请手动选择复制')
  }
}

onUnmounted(() => {
  stopLoginPolling()
})

/** 登录状态行：git 身份 / GitHub 登录 / owner */
const authRows = computed(() => {
  const s = store.marketStatus
  if (!s) return []
  return [
    { label: '本地 git 身份', ok: s.git_configured, note: s.git_configured ? '已配置 user.name / user.email' : '未配置' },
    {
      label: 'GitHub 登录',
      ok: Boolean(s.auth_source),
      note: s.auth_source === 'token'
        ? `PAT 令牌（…${s.token_tail}）`
        : s.auth_source === 'gh'
          ? 'gh 已登录'
          : '未登录',
    },
    { label: 'GitHub 账号', ok: Boolean(s.owner), note: s.owner ?? '未解析' },
  ]
})

/** 市场状态徽章 */
const statusBadge = computed(() => {
  const s = store.marketStatus
  if (!s) return { label: '检测中…', variant: 'neutral' }
  return s.ready
    ? { label: '已就绪', variant: 'success' }
    : { label: '未就绪', variant: 'warning' }
})

/** 最终结果链接（submitted 后展示） */
const resultLinks = computed(() => {
  const r = run.value
  if (!r || r.status !== 'submitted') return null
  return [
    { label: '源码仓库', url: r.repo ? `https://github.com/${r.repo}` : null },
    { label: 'Release', url: r.release_url },
    { label: '市场 Pull Request', url: r.pr_url },
  ].filter((item) => item.url)
})
</script>

<template>
  <Dialog
    v-model="open"
    title="上传到插件市场"
    description="按 Extension.Example 模板生成扩展仓库 → 推送到 GitHub → 创建 Release → 向市场提交注册 PR"
    :hide-footer="true"
    width="min(560px, calc(100vw - 32px))"
  >
    <!-- 登录状态 -->
    <section class="auth-card">
      <div class="auth-head">
        <div class="auth-head-left">
          <span class="auth-icon"><Icon icon="lucide:github" width="16" /></span>
          <span class="auth-title">GitHub 登录状态</span>
        </div>
        <Badge :variant="statusBadge.variant">{{ statusBadge.label }}</Badge>
      </div>

      <div class="auth-rows">
        <div v-for="row in authRows" :key="row.label" class="auth-row">
          <span class="auth-status-icon" :class="row.ok ? 'ok' : 'no'">
            <Icon :icon="row.ok ? 'lucide:check' : 'lucide:x'" width="12" />
          </span>
          <span class="auth-label">{{ row.label }}</span>
          <span class="auth-note">{{ row.note }}</span>
        </div>
      </div>

      <!-- 未就绪：登录引导 -->
      <div v-if="needsSetup" class="guidance">
        <p class="guidance-title">
          <Icon icon="lucide:info" width="14" />
          需要先完成 GitHub 登录：
        </p>

        <!-- gh 未安装：一键安装 -->
        <div v-if="!store.marketStatus?.gh_available" class="guidance-block">
          <p class="guidance-desc">未检测到 GitHub CLI（gh），点击下方按钮自动下载并安装当前系统的安装包。</p>
          <Button size="sm" :loading="installingGh" @click="installGh">
            <Icon icon="lucide:download" width="13" />
            {{ installingGh ? '安装中…' : '一键安装 GitHub CLI' }}
          </Button>
        </div>

        <!-- gh 已安装但未登录：一键登录 -->
        <div v-else-if="!store.marketStatus?.gh_authed" class="guidance-block">
          <p class="guidance-desc">点击「登录 GitHub」生成一次性验证码，在浏览器中打开授权地址并输入验证码即可完成登录。</p>
          <Button size="sm" variant="primary" :loading="loggingIn" @click="startLogin">
            <Icon icon="lucide:log-in" width="13" />
            {{ loggingIn ? '生成验证码中…' : '登录 GitHub' }}
          </Button>
        </div>

        <!-- 其他未就绪原因（git 身份缺失等）：展示指引 -->
        <pre v-else class="guidance-cmd">{{ store.marketStatus?.guidance }}</pre>

        <!-- 登录验证码展示 -->
        <div v-if="loginInfo" class="login-code">
          <div class="login-code-head">
            <Icon icon="lucide:key-round" width="14" />
            <span>在浏览器中完成授权</span>
          </div>
          <ol class="login-steps">
            <li>复制下方一次性验证码</li>
            <li>
              打开授权地址
              <a :href="loginInfo.url" target="_blank" rel="noopener">{{ loginInfo.url }}</a>
            </li>
            <li>粘贴验证码并确认授权，完成后自动检测登录态</li>
          </ol>
          <div class="login-code-value">
            <code>{{ loginInfo.code }}</code>
            <Button size="sm" variant="ghost" @click="copyLoginCode">
              <Icon icon="lucide:copy" width="13" /> 复制
            </Button>
          </div>
          <div class="login-code-actions">
            <Button size="sm" variant="ghost" @click="cancelLogin">
              <Icon icon="lucide:x" width="13" /> 取消登录
            </Button>
          </div>
        </div>

        <div class="guidance-actions">
          <Button size="sm" variant="ghost" @click="router.push('/admin')">
            <Icon icon="lucide:settings" width="13" /> 去设置粘贴 Token
          </Button>
        </div>
      </div>
    </section>

    <!-- 未开始：开始上传 -->
    <section v-if="!run || (run.status !== 'running' && run.status !== 'submitted')" class="start-card">
      <div class="start-icon"><Icon icon="lucide:store" width="18" /></div>
      <p class="start-hint">
        将把校验通过的扩展按官方模板生成仓库并发布到插件市场；Release 资产由仓库内置的打包工作流生成。
      </p>
      <Button
        variant="primary"
        class="start-btn"
        :disabled="!store.marketStatus?.ready || starting"
        :loading="starting"
        @click="startUpload"
      >
        <Icon v-if="!starting" icon="lucide:rocket" width="15" />
        {{ starting ? '启动中…' : '开始上传' }}
      </Button>
    </section>

    <!-- 进行中 / 已完成 / 失败：步骤进度 -->
    <section v-if="run" class="run-card">
      <div class="run-head">
        <span class="run-title">
          {{ running ? '正在上传…' : run.status === 'submitted' ? '上传提交成功' : '上传失败' }}
        </span>
        <Badge v-if="run.status === 'submitted'" variant="success">已提交</Badge>
        <Badge v-else-if="run.status === 'failed'" variant="danger">失败</Badge>
        <Badge v-else variant="accent">进行中</Badge>
      </div>

      <ol class="step-list">
        <li
          v-for="step in run.steps"
          :key="step.id"
          class="step-item"
          :class="stepVisual(step.status).cls"
        >
          <span class="step-icon" :class="stepVisual(step.status).cls">
            <Icon
              :icon="stepVisual(step.status).icon"
              width="15"
              :class="{ spin: step.status === 'running' }"
            />
          </span>
          <div class="step-main">
            <span class="step-name">{{ step.name }}</span>
            <span v-if="step.message" class="step-msg">{{ step.message }}</span>
          </div>
        </li>
      </ol>

      <p v-if="run.error" class="run-error">
        <Icon icon="lucide:triangle-alert" width="14" />
        {{ run.error }}
      </p>

      <!-- 结果链接 -->
      <div v-if="resultLinks" class="result-links">
        <a v-for="item in resultLinks" :key="item.label" :href="item.url" target="_blank" rel="noopener">
          <Icon icon="lucide:external-link" width="13" />
          {{ item.label }}
        </a>
      </div>

      <div class="run-actions">
        <Button variant="ghost" size="sm" @click="open = false">关闭</Button>
        <Button
          v-if="!running"
          variant="secondary"
          size="sm"
          :disabled="!store.marketStatus?.ready"
          @click="startUpload"
        >
          重新上传
        </Button>
      </div>
    </section>
  </Dialog>
</template>

<style scoped>
.auth-card,
.start-card,
.run-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  background: var(--surface);
}

/* ---- 登录状态 ---- */
.auth-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.auth-head-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.auth-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
}

.auth-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.auth-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.auth-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
}

.auth-status-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex-shrink: 0;
}

.auth-status-icon.ok {
  background: var(--success-soft);
  color: var(--success);
}

.auth-status-icon.no {
  background: var(--danger-soft);
  color: var(--danger);
}

.auth-label {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.auth-note {
  color: var(--text-muted);
  font-size: var(--text-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 登录引导 ---- */
.guidance {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--warning-soft);
  border: 1px solid var(--border-warning);
  border-radius: var(--radius);
}

.guidance-title {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--warning);
  line-height: 1.5;
}

.guidance-title svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.guidance-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

.guidance-desc {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.6;
}

.guidance-cmd {
  margin: 0;
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  line-height: 1.6;
}

.guidance-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

/* ---- 登录验证码 ---- */
.login-code {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.login-code-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.login-code-head svg {
  color: var(--accent);
}

.login-steps {
  margin: 0;
  padding-left: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.6;
}

.login-steps a {
  color: var(--accent);
  text-decoration: none;
  word-break: break-all;
}

.login-steps a:hover {
  text-decoration: underline;
}

.login-code-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
}

.login-code-value code {
  font-size: var(--text-base);
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--accent);
  user-select: all;
}

.login-code-actions {
  display: flex;
  justify-content: flex-end;
}

/* ---- 开始上传 ---- */
.start-card {
  align-items: center;
  text-align: center;
}

.start-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-lg);
  background: var(--accent-soft);
  color: var(--accent);
}

.start-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
  line-height: 1.6;
}

.start-btn {
  width: 100%;
  justify-content: center;
}

/* ---- 步骤进度 ---- */
.run-card {
  gap: var(--space-3);
}

.run-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.run-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.step-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.step-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  transition: background 150ms ease-out;
}

.step-item.running {
  background: var(--accent-soft);
}

.step-item.failed {
  background: var(--danger-soft);
}

.step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 1px;
}

.step-icon.passed {
  background: var(--success-soft);
  color: var(--success);
}

.step-icon.running {
  background: var(--accent-soft);
  color: var(--accent);
}

.step-icon.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.step-icon.pending {
  background: var(--bg);
  color: var(--border-strong);
}

.step-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.step-name {
  color: var(--text);
}

.step-item.pending .step-name {
  color: var(--text-muted);
}

.step-msg {
  font-size: var(--text-xs);
  color: var(--text-muted);
  word-break: break-all;
}

.run-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-3);
  background: var(--danger-soft);
  border: 1px solid var(--border-danger);
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: var(--danger);
  line-height: 1.5;
  word-break: break-word;
}

.run-error svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.result-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.result-links a {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-xs);
  color: var(--accent);
  text-decoration: none;
  background: var(--surface);
}

.result-links a:hover {
  border-color: var(--accent);
}

.run-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.spin {
  animation: spin 1s linear infinite;
}
</style>
