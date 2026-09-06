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

// ===== GitHub 登录（后台 gh device flow） =====

/** 登录请求进行中 */
const loggingIn = ref(false)
/** 后端返回的登录信息（code + url） */
const loginInfo = ref(null)
/** 登录态轮询定时器 */
let loginPollTimer = null

/** 一键登录：后端启动 gh device flow，返回 one-time code + URL 供展示 */
async function startLogin() {
  loggingIn.value = true
  loginInfo.value = null
  try {
    const info = await store.startGhLogin()
    if (info.pending && info.code) {
      loginInfo.value = info
      toast_success('已生成登录验证码，请在浏览器完成授权')
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

/** 轮询登录态：gh 授权完成后刷新，自动关闭验证码面板 */
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

/** 取消登录（放弃授权时调用） */
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
    title="发布到插件市场"
    description="在 GitHub 生成扩展仓库并推送，创建 Release 打包后向 UniBot 市场提交注册"
    :hide-footer="true"
    width="min(620px, calc(100vw - 32px))"
  >
    <!-- 流程指示条 -->
    <div v-if="!run || run.status !== 'running'" class="flow-steps">
      <div class="flow-step" :class="{ active: needsSetup }">
        <span class="flow-dot" :class="{ ok: !needsSetup && store.marketStatus?.ready }">
          <Icon v-if="!needsSetup && store.marketStatus?.ready" icon="lucide:check" width="11" />
          <template v-else>1</template>
        </span>
        <span class="flow-label">就绪检查</span>
      </div>
      <span class="flow-connector" :class="{ on: !needsSetup && store.marketStatus?.ready }" />
      <div class="flow-step" :class="{ active: !needsSetup && !run }">
        <span class="flow-dot" :class="{ ok: !needsSetup && !run }">
          <Icon v-if="!needsSetup && !run" icon="lucide:check" width="11" />
          <template v-else>2</template>
        </span>
        <span class="flow-label">推送仓库</span>
      </div>
      <span class="flow-connector" />
      <div class="flow-step">
        <span class="flow-dot">3</span>
        <span class="flow-label">提交注册</span>
      </div>
    </div>

    <!-- 未就绪：登录与准备引导 -->
    <section v-if="needsSetup" class="panel">
      <div class="panel-head">
        <span class="head-icon"><Icon icon="lucide:github" width="16" /></span>
        <div class="head-text">
          <span class="head-title">GitHub 就绪检查</span>
          <span class="head-sub">完成以下步骤即可发布扩展</span>
        </div>
      </div>

      <div class="check-list">
        <div v-for="row in authRows" :key="row.label" class="check-item">
          <span class="check-dot" :class="row.ok ? 'ok' : 'no'">
            <Icon :icon="row.ok ? 'lucide:check' : 'lucide:alert-circle'" width="12" />
          </span>
          <div class="check-text">
            <span class="check-label">{{ row.label }}</span>
            <span class="check-note">{{ row.note }}</span>
          </div>
        </div>
      </div>

      <!-- gh 未安装：引导安装 -->
      <div v-if="!store.marketStatus?.gh_available" class="action-box">
        <div class="action-body">
          <Icon icon="lucide:terminal" width="16" class="action-lead" />
          <div class="action-text">
            <span class="action-title">需要安装 GitHub CLI</span>
            <span class="action-desc">自动下载并安装匹配当前系统的 gh，无需在终端操作。</span>
          </div>
        </div>
        <div class="action-ctrl">
          <Button size="sm" variant="secondary" :loading="installingGh" @click="installGh">
            <Icon icon="lucide:download" width="13" />
            {{ installingGh ? '安装中…' : '自动安装' }}
          </Button>
        </div>
      </div>

      <!-- 已装 gh 但未登录（且未配 token）：一键登录 -->
      <div v-else-if="!store.marketStatus?.gh_authed && !store.marketStatus?.token_configured" class="action-box">
        <div class="action-body">
          <Icon icon="lucide:log-in" width="16" class="action-lead" />
          <div class="action-text">
            <span class="action-title">登录 GitHub 账号</span>
            <span class="action-desc">后台启动 gh 登录，生成一次性验证码后在浏览器完成授权即可，无需敲命令。</span>
          </div>
        </div>
        <div class="action-ctrl">
          <Button size="sm" variant="primary" :loading="loggingIn" @click="startLogin">
            <Icon icon="lucide:github" width="13" />
            {{ loggingIn ? '生成中…' : '登录 GitHub' }}
          </Button>
        </div>
      </div>

      <!-- 其余未就绪（已配 token 但缺 owner/git 等，或需 token 兜底）：展示指引 -->
      <div v-else class="action-box">
        <div class="action-body">
          <Icon icon="lucide:info" width="16" class="action-lead" />
          <div class="action-text">
            <span class="action-title">还需完成一些配置</span>
            <span class="action-desc">{{ store.marketStatus?.guidance }}</span>
          </div>
        </div>
        <div class="action-ctrl">
          <Button size="sm" variant="ghost" @click="router.push('/admin')">
            去设置
          </Button>
        </div>
      </div>
    </section>

    <!-- 授权验证码（登录进行中展示） -->
    <section v-if="loginInfo" class="panel auth-flow">
      <div class="panel-head">
        <span class="head-icon accent"><Icon icon="lucide:key-round" width="16" /></span>
        <div class="head-text">
          <span class="head-title">在浏览器完成授权</span>
          <span class="head-sub">本窗口会等待授权完成，完成后自动继续</span>
        </div>
      </div>

      <ol class="login-steps">
        <li>
          <span class="step-no">1</span>
          <span>复制下方一次性验证码</span>
        </li>
        <li>
          <span class="step-no">2</span>
          <span>
            打开
            <a :href="loginInfo.url" target="_blank" rel="noopener">GitHub 授权页</a>
            并粘贴验证码
          </span>
        </li>
        <li>
          <span class="step-no">3</span>
          <span>确认授权，本窗口将自动检测到登录成功</span>
        </li>
      </ol>

      <div class="code-row">
        <span class="code-box">{{ loginInfo.code }}</span>
        <Button size="sm" variant="secondary" @click="copyLoginCode">
          <Icon icon="lucide:copy" width="13" /> 复制
        </Button>
        <a :href="loginInfo.url" target="_blank" rel="noopener">
          <Button size="sm" variant="primary">
            <Icon icon="lucide:external-link" width="13" /> 打开授权页
          </Button>
        </a>
      </div>

      <div class="auth-flow-foot">
        <Button size="sm" variant="ghost" @click="cancelLogin">取消登录</Button>
      </div>
    </section>

    <!-- 就绪：开始上传 -->
    <section v-if="!needsSetup && !run" class="panel upload-cta">
      <div class="upload-visual">
        <Icon icon="lucide:package-open" width="22" />
      </div>
      <div class="upload-copy">
        <span class="upload-title">一切就绪，开始发布</span>
        <span class="upload-sub">
          将按官方模板生成仓库并推送到
          <b>github.com/{{ store.marketStatus?.owner }}</b>
          ，随后创建 Release 并向 UniBot 市场提交注册。
        </span>
      </div>
      <Button
        variant="primary"
        class="upload-btn"
        :disabled="starting"
        :loading="starting"
        @click="startUpload"
      >
        <Icon v-if="!starting" icon="lucide:send" width="14" />
        {{ starting ? '启动中…' : '开始上传' }}
      </Button>
    </section>

    <!-- 进行中 / 已完成 / 失败：步骤进度 -->
    <section v-if="run" class="panel">
      <div class="run-head">
        <div class="head-left">
          <span class="head-icon" :class="run.status">
            <Icon
              :icon="running ? 'lucide:loader-2' : run.status === 'submitted' ? 'lucide:check' : 'lucide:x'"
              width="16"
              :class="{ spin: running }"
            />
          </span>
          <div class="head-text">
            <span class="head-title">
              {{ running ? '正在发布到插件市场…' : run.status === 'submitted' ? '发布成功' : '发布失败' }}
            </span>
            <span v-if="run.version" class="head-sub">{{ props.draft?.name }} · v{{ run.version }}</span>
          </div>
        </div>
        <Badge v-if="run.status === 'submitted'" variant="success">已完成</Badge>
        <Badge v-else-if="run.status === 'failed'" variant="danger">失败</Badge>
        <Badge v-else variant="accent">进行中</Badge>
      </div>

      <ol class="step-list">
        <li
          v-for="(step, index) in run.steps"
          :key="step.id"
          class="step-item"
          :class="stepVisual(step.status).cls"
        >
          <span class="step-rail">
            <span class="step-icon" :class="stepVisual(step.status).cls">
              <Icon
                :icon="stepVisual(step.status).icon"
                width="14"
                :class="{ spin: step.status === 'running' }"
              />
            </span>
            <span v-if="index < run.steps.length - 1" class="step-line" :class="{ on: step.status === 'passed' }" />
          </span>
          <div class="step-main">
            <span class="step-name">{{ step.name }}</span>
            <span v-if="step.message" class="step-msg">{{ step.message }}</span>
          </div>
          <span v-if="step.status === 'failed'" class="step-status">
            <Icon icon="lucide:alert-circle" width="14" />
          </span>
        </li>
      </ol>

      <p v-if="run.error" class="run-error">
        <Icon icon="lucide:triangle-alert" width="14" />
        <span>{{ run.error }}</span>
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
          v-if="!running && store.marketStatus?.ready"
          variant="secondary"
          size="sm"
          @click="startUpload"
        >
          <Icon icon="lucide:rotate-ccw" width="13" /> 重新上传
        </Button>
      </div>
    </section>
  </Dialog>
</template>

<style scoped>
/* 面板容器：同一内容骨架，按阶段切换内部卡片 */
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  background: var(--surface);
}

/* ---- 流程指示条 ---- */
.flow-steps {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border);
}

.flow-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  flex: 0 0 auto;
}

.flow-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: 600;
  transition:
    background-color var(--transition),
    border-color var(--transition),
    color var(--transition);
}

.flow-step.active .flow-dot {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.flow-step .flow-dot.ok {
  border-color: transparent;
  background: var(--success-soft);
  color: var(--success);
}

.flow-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
  white-space: nowrap;
}

.flow-step.active .flow-label {
  color: var(--text-secondary);
  font-weight: 500;
}

.flow-connector {
  flex: 1;
  height: 1px;
  align-self: flex-start;
  margin-top: 11px;
  background: var(--border);
  transition: background var(--transition);
}

.flow-connector.on {
  background: var(--success);
}

/* ---- 面板头部 ---- */
.panel-head,
.run-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.run-head {
  align-items: center;
  justify-content: space-between;
}

.head-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.head-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
}

.head-icon.accent {
  background: var(--success-soft);
  color: var(--success);
}

.head-icon.submitted {
  background: var(--success-soft);
  color: var(--success);
}

.head-icon.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.head-icon.running {
  background: var(--accent-soft);
  color: var(--accent);
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.head-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.01em;
}

.head-sub {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

/* ---- 就绪检查清单 ---- */
.check-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-sunken);
  border-radius: var(--radius-md);
}

.check-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-2);
}

.check-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex-shrink: 0;
}

.check-dot.ok {
  background: var(--success-soft);
  color: var(--success);
}

.check-dot.no {
  background: var(--danger-soft);
  color: var(--danger);
}

.check-text {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.check-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text);
  flex-shrink: 0;
}

.check-note {
  font-size: var(--text-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 就绪引导操作块 ---- */
.action-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--accent-soft);
  border: 1px solid rgb(37 99 235 / 0.14);
  border-radius: var(--radius-md);
}

.action-body {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
}

.action-lead {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 1px;
}

.action-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.action-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.action-desc {
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.6;
  min-width: 0;
}

.action-ctrl {
  flex-shrink: 0;
}

/* ---- 授权验证码面板 ---- */
.auth-flow {
  border-color: rgb(22 163 74 / 0.2);
}

.auth-flow .panel-head {
  align-items: center;
}

.login-steps {
  margin: 0;
  padding: var(--space-2) var(--space-5) var(--space-1);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  list-style: none;
}

.login-steps li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.6;
}

.login-steps a {
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
}

.login-steps a:hover {
  text-decoration: underline;
}

.step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--success-soft);
  color: var(--success);
  font-size: var(--text-xs);
  font-weight: 600;
  flex-shrink: 0;
  margin-top: 2px;
}

.code-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  flex-wrap: wrap;
}

.code-box {
  flex: 1;
  font-family: var(--font-mono);
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--accent);
  text-align: center;
  user-select: all;
  min-width: 0;
}

.code-row a {
  text-decoration: none;
  display: inline-flex;
}

.auth-flow-foot {
  display: flex;
  justify-content: flex-end;
}

/* ---- 就绪上传 CTA ---- */
.upload-cta {
  align-items: flex-start;
  gap: var(--space-4);
}

.upload-visual {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-lg);
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
}

.upload-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.upload-title {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text);
}

.upload-sub {
  font-size: var(--text-sm);
  color: var(--text-muted);
  line-height: 1.6;
}

.upload-sub b {
  color: var(--text-secondary);
  font-weight: 600;
}

.upload-btn {
  align-self: stretch;
  justify-content: center;
  height: 40px;
  font-size: var(--text-sm);
}

/* ---- 步骤时间线 ---- */
.step-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.step-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  transition: background 150ms ease-out;
}

.step-item.running {
  background: var(--accent-soft);
}

.step-item.failed {
  background: var(--danger-soft);
}

.step-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 22px;
}

.step-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
}

.step-icon.passed {
  background: var(--success-soft);
  color: var(--success);
}

.step-icon.running {
  background: var(--surface);
  color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.step-icon.failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.step-icon.pending {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--border-strong);
}

.step-line {
  width: 2px;
  flex: 1;
  min-height: 16px;
  margin: var(--space-1) 0;
  background: var(--border);
  border-radius: 1px;
}

.step-line.on {
  background: var(--success);
}

.step-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding-top: 2px;
}

.step-name {
  color: var(--text);
  font-weight: 500;
}

.step-item.pending .step-name {
  color: var(--text-muted);
  font-weight: 400;
}

.step-msg {
  font-size: var(--text-xs);
  color: var(--text-muted);
  word-break: break-all;
}

.step-status {
  margin-left: auto;
  color: var(--danger);
  align-self: flex-start;
  padding-top: 2px;
}

/* ---- 错误提示 ---- */
.run-error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--danger-soft);
  border: 1px solid var(--border-danger);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--danger);
  line-height: 1.5;
  word-break: break-word;
}

.run-error svg {
  flex-shrink: 0;
  margin-top: 2px;
}

/* ---- 结果链接 ---- */
.result-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.result-links a {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  height: 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--accent);
  text-decoration: none;
  background: var(--surface);
  transition:
    border-color var(--transition),
    background var(--transition);
}

.result-links a:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* ---- 底部操作 ---- */
.run-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}

.spin {
  animation: spin 1s linear infinite;
}
</style>
