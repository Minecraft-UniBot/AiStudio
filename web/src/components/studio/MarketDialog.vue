<script setup>
// 上传插件市场对话框：登录态检测 + 步骤进度 + 结果链接
// 流程（后端 studio/market.ts）：precheck → auth → scaffold → commit → repo → push → release → asset → market_pr
// 全部通过 git/gh 命令行驱动；未登录时展示引导（终端 gh auth login 或去平台设置粘贴 PAT）
import { onMounted, watch, ref, computed } from 'vue'
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
        <span class="auth-title">GitHub 登录状态</span>
        <Badge :variant="statusBadge.variant">{{ statusBadge.label }}</Badge>
      </div>
      <div class="auth-rows">
        <div v-for="row in authRows" :key="row.label" class="auth-row">
          <Icon
            :icon="row.ok ? 'lucide:check-circle-2' : 'lucide:x-circle'"
            width="15"
            :class="row.ok ? 'ok' : 'no'"
          />
          <span class="auth-label">{{ row.label }}</span>
          <span class="auth-note">{{ row.note }}</span>
        </div>
      </div>

      <!-- 未就绪：登录引导 -->
      <div v-if="needsSetup" class="guidance">
        <p class="guidance-title">
          <Icon icon="lucide:info" width="14" />
          需要先完成 GitHub 登录（在运行 Studio 的终端执行）：
        </p>
        <pre class="guidance-cmd">{{ store.marketStatus?.guidance }}</pre>
        <div class="guidance-actions">
          <Button size="sm" @click="router.push('/admin')">
            <Icon icon="lucide:settings" width="13" /> 去设置粘贴 Token
          </Button>
        </div>
      </div>
    </section>

    <!-- 未开始：开始上传 -->
    <section v-if="!run || (run.status !== 'running' && run.status !== 'submitted')" class="start-card">
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
        <Icon v-if="!starting" icon="lucide:store" width="15" />
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
          <Icon
            :icon="stepVisual(step.status).icon"
            width="15"
            :class="{ spin: step.status === 'running' }"
          />
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
  border-radius: var(--radius-md);
  padding: var(--space-4);
  background: var(--surface);
}

.auth-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
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

.auth-row svg.ok {
  color: var(--success);
}

.auth-row svg.no {
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

/* 登录引导 */
.guidance {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  border-radius: var(--radius);
}

.guidance-title {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: 0;
  font-size: var(--text-sm);
  color: #92400e;
  line-height: 1.5;
}

.guidance-title svg {
  flex-shrink: 0;
  margin-top: 2px;
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
}

/* 开始 */
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

/* 步骤进度 */
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
}

.step-item svg {
  flex-shrink: 0;
  margin-top: 1px;
}

.step-item.passed svg {
  color: var(--success);
}

.step-item.running svg {
  color: var(--accent);
}

.step-item.failed svg {
  color: var(--danger);
}

.step-item.pending svg {
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
  border: 1px solid #fecaca;
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
