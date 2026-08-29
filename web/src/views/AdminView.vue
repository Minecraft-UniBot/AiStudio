<script setup>
// 平台设置：功能开关、OpenCode 工具注册表、提示词模板展示
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { Icon } from '@iconify/vue'
import { api } from '@/utils/api'
import { useStudioStore } from '@/stores/studio'
import { use_toast } from '@/composables/use_toast'
import Button from '@/components/ui/Button.vue'
import Checkbox from '@/components/ui/Checkbox.vue'
import Input from '@/components/ui/Input.vue'
import Select from '@/components/ui/Select.vue'
import Badge from '@/components/ui/Badge.vue'
import UnibotDirSetupDialog from '@/components/studio/UnibotDirSetupDialog.vue'
import CustomProviderDialog from '@/components/studio/CustomProviderDialog.vue'

const router = useRouter()
const store = useStudioStore()
const { success: toast_success, error: toast_error } = use_toast()

const settings = ref(null)
const tools = ref([])
const prompts = ref([])
const saving = ref(false)
// UniBot 目录设置对话框（编辑现有目录 / 首次未配置时引导）
const dirSetupOpen = ref(false)

// 自定义 OpenAI 兼容提供商
const providerDialogOpen = ref(false)
const removingProvider = ref('')

// 插件市场设置：登录态检测 + token / owner / 仓库可见性
const marketStatus = ref(null)
const marketToken = ref('')
const marketOwner = ref('')
const marketVisibility = ref('public')
const marketSaving = ref(false)

onMounted(async () => {
  store.fetchStatus()
  await loadAll()
  // 自定义提供商列表（用于区分内置 Zen 网关与自定义项）；失败不阻塞设置页
  store.fetchCustomProviders().catch(() => {})
  loadMarketStatus()
})

/** 是否为自定义提供商（可删除） */
function isCustom(provider) {
  return store.customProviders.some((p) => p.id === provider.provider_id)
}

async function removeProvider(provider) {
  removingProvider.value = provider.provider_id
  try {
    await store.removeCustomProvider(provider.provider_id)
    toast_success(`已删除「${provider.label}」并重载 OpenCode`)
  } catch (e) {
    toast_error(e.message)
  } finally {
    removingProvider.value = ''
  }
}

async function loadAll() {
  const results = await Promise.allSettled([
    api('/settings'),
    api('/tools'),
    api('/prompts'),
  ])
  if (results[0].status === 'fulfilled') settings.value = results[0].value
  if (results[1].status === 'fulfilled') tools.value = results[1].value
  if (results[2].status === 'fulfilled') prompts.value = results[2].value
  // 未配置 UniBot 目录时主动弹出引导
  if (settings.value && settings.value.unibot_configured === false) {
    dirSetupOpen.value = true
  }
}

// 设置 UniBot 目录后：刷新设置与平台状态（顶部徽章 / 发布逻辑读到新目录）
function onUnibotDirSaved() {
  loadAll()
  store.fetchStatus()
  toast_success('UniBot 目录已保存')
}

async function saveSettings() {
  saving.value = true
  try {
    settings.value = await api('/settings', {
      method: 'PATCH',
      body: { features: settings.value.features },
    })
    toast_success('设置已保存')
  } catch (e) {
    toast_error(e.message)
  } finally {
    saving.value = false
  }
}

async function toggleTool(tool) {
  tool.enabled = !tool.enabled
  try {
    tools.value = await api('/tools', { method: 'PATCH', body: tools.value })
  } catch (e) {
    tool.enabled = !tool.enabled
    toast_error(e.message)
  }
}

function permissionVariant(permission) {
  if (permission === 'reject') return 'danger'
  if (permission === 'ask') return 'warning'
  return 'neutral'
}

// ===== 插件市场设置 =====

/** 拉取市场登录态/配置（git 身份、gh 登录、token 尾号、owner） */
async function loadMarketStatus() {
  try {
    marketStatus.value = await store.fetchMarketStatus()
    marketOwner.value = marketStatus.value?.owner ?? ''
    marketVisibility.value = marketStatus.value?.repo_visibility ?? 'public'
    // 不预填 token（永不下发明文；留空表示不修改）
    marketToken.value = ''
  } catch (e) {
    toast_error(e.message)
  }
}

/** 保存市场配置（token 留空表示保持原样） */
async function saveMarketConfig() {
  marketSaving.value = true
  try {
    const patch = { owner: marketOwner.value, repo_visibility: marketVisibility.value }
    if (marketToken.value.trim()) patch.token = marketToken.value.trim()
    marketStatus.value = await store.saveMarketConfig(patch)
    marketToken.value = ''
    toast_success('市场配置已保存')
  } catch (e) {
    toast_error(e.message)
  } finally {
    marketSaving.value = false
  }
}

/** 登录状态徽章 */
const marketBadge = computed(() => {
  const s = marketStatus.value
  if (!s) return { label: '检测中…', variant: 'neutral' }
  return s.ready
    ? { label: '已就绪', variant: 'success' }
    : { label: '未就绪', variant: 'warning' }
})

// ---- 外观主题 ----
const themeOptions = [
  { value: 'light', label: '亮色', icon: 'lucide:sun' },
  { value: 'dark', label: '暗色', icon: 'lucide:moon' },
  { value: 'system', label: '跟随系统', icon: 'lucide:monitor' },
]

const currentTheme = ref('system')

function setTheme(theme) {
  currentTheme.value = theme
  window.__studio_setTheme?.(theme)
  toast_success(`主题已切换为「${themeOptions.find((t) => t.value === theme)?.label ?? theme}」`)
}

// 初始化：从全局方法读取当前主题
onMounted(() => {
  currentTheme.value = window.__studio_getTheme?.() ?? 'system'
})
</script>

<template>
  <div class="admin-page">
    <header class="topbar">
      <Button variant="ghost" icon-only title="返回草稿列表" @click="router.push('/')">
        <Icon icon="lucide:arrow-left" width="16" />
      </Button>
      <span class="title">平台设置</span>
      <div class="spacer" />
      <Badge :variant="store.opencodeAvailable ? 'success' : 'neutral'">
        <span class="status-dot" />
        OpenCode {{ store.status?.version ?? '未连接' }}
      </Badge>
    </header>

    <main class="content">
      <div class="content-inner">
      <!-- 页头 -->
      <div class="page-head">
        <h1>平台设置</h1>
        <p>管理功能开关、模型提供商、OpenCode 工具注册表与提示词模板</p>
      </div>

      <!-- 外观主题 -->
      <section class="card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:palette" width="16" /></span>
          <div class="card-titles">
            <h3>外观主题</h3>
            <p>切换亮色 / 暗色 / 跟随系统</p>
          </div>
        </header>
        <div class="card-body">
          <div class="theme-options">
            <button
              v-for="opt in themeOptions"
              :key="opt.value"
              class="theme-btn"
              :class="{ active: currentTheme === opt.value }"
              @click="setTheme(opt.value)"
            >
              <Icon :icon="opt.icon" width="16" />
              <span>{{ opt.label }}</span>
            </button>
          </div>
        </div>
      </section>

      <!-- 功能开关 -->
      <section v-if="settings" class="card feature-card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:sliders-horizontal" width="16" /></span>
          <div class="card-titles">
            <h3>功能开关</h3>
            <p>平台能力启停，保存后立即生效</p>
          </div>
          <Button variant="primary" size="sm" :loading="saving" @click="saveSettings">
            <Icon icon="lucide:save" width="14" /> {{ saving ? '保存中…' : '保存' }}
          </Button>
        </header>
        <div class="card-body">
          <label class="feature-item">
            <Checkbox v-model="settings.features.test_tools" />
            <div class="feature-text">
              <span>测试工具（OpenCode 插件）</span>
              <small>编码时 AI 用 unibot_* 工具在共享测试环境自测</small>
            </div>
          </label>
          <label class="feature-item disabled">
            <Checkbox v-model="settings.features.mc_test_environment" disabled />
            <div class="feature-text">
              <span>MC 测试环境</span>
              <small>备用方案，暂未实现</small>
            </div>
          </label>
          <label class="feature-item">
            <Checkbox v-model="settings.features.market_publish" />
            <div class="feature-text">
              <span>市场发布</span>
              <small>按 Extension.Example 模板生成仓库并推送到 GitHub，创建 Release 后向市场提交注册 PR</small>
            </div>
          </label>
          <label class="feature-item">
            <Checkbox v-model="settings.features.git_integration" />
            <div class="feature-text">
              <span>Git / PR 工作流</span>
              <small>git/gh 命令行驱动：仓库创建、推送、Release 与市场 Pull Request（未登录时引导登录）</small>
            </div>
          </label>
        </div>
      </section>

      <!-- 模型提供商：内置仅保留 OpenCode Zen 免费网关，其余走自定义 OpenAI 兼容 -->
      <section class="card provider-card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:boxes" width="16" /></span>
          <div class="card-titles">
            <h3>模型提供商</h3>
            <p>内置仅保留 OpenCode Zen 免费网关；其他渠道请添加 OpenAI 兼容提供商（NewApi 等）</p>
          </div>
          <Button variant="primary" size="sm" @click="providerDialogOpen = true">
            <Icon icon="lucide:plus" width="14" /> 添加
          </Button>
        </header>
        <div class="card-body">
          <!-- 加载失败：给出重试入口，而不是静默空白 -->
          <div v-if="store.optionsError && store.options.providers.length === 0" class="provider-empty danger">
            <Icon icon="lucide:server-off" width="18" />
            <span>{{ store.optionsError }}</span>
            <button type="button" class="link" @click="store.fetchOptions()">重试</button>
          </div>
          <div v-else-if="store.options.providers.length === 0" class="provider-empty">
            <Icon icon="lucide:inbox" width="18" />
            <span>暂无可用提供商</span>
          </div>
          <div v-else class="item-list">
            <div v-for="p in store.options.providers" :key="p.provider_id" class="row-item">
              <div class="row-main">
                <div class="row-title">
                  <span class="row-name">{{ p.label }}</span>
                  <span class="mono row-id">{{ p.provider_id }}</span>
                  <Badge v-if="isCustom(p)" variant="accent">自定义</Badge>
                  <Badge v-else variant="neutral">内置 · 免费</Badge>
                </div>
                <div class="chip-row">
                  <span v-for="m in p.models.slice(0, 8)" :key="m.id" class="chip mono">{{ m.id }}</span>
                  <span v-if="p.models.length > 8" class="chip more">+{{ p.models.length - 8 }}</span>
                </div>
              </div>
              <Button
                v-if="isCustom(p)"
                size="sm"
                variant="danger"
                :loading="removingProvider === p.provider_id"
                @click="removeProvider(p)"
              >
                删除
              </Button>
            </div>
          </div>
        </div>
      </section>

      <!-- 工具注册表 -->
      <section class="card tools-card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:wrench" width="16" /></span>
          <div class="card-titles">
            <h3>OpenCode 工具注册表</h3>
            <p>AI 编码时可调用的 unibot_* 测试工具与默认权限</p>
          </div>
        </header>
        <div class="card-body">
          <div class="item-list">
            <div v-for="tool in tools" :key="tool.id" class="row-item">
              <div class="row-main">
                <div class="row-title">
                  <span class="mono row-name">{{ tool.id }}</span>
                  <Badge :variant="permissionVariant(tool.default_permission)">
                    {{ tool.default_permission }}
                  </Badge>
                </div>
                <small class="row-note">{{ tool.note }}</small>
              </div>
              <Button size="sm" :variant="tool.enabled ? 'primary' : 'secondary'" @click="toggleTool(tool)">
                {{ tool.enabled ? '已启用' : '已停用' }}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <!-- 提示词模板（只读展示） -->
      <section class="card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:scroll-text" width="16" /></span>
          <div class="card-titles">
            <h3>提示词模板</h3>
            <p>平台内置提示词与当前启用的版本</p>
          </div>
        </header>
        <div class="card-body">
          <div class="item-list">
            <div v-for="prompt in prompts" :key="prompt.name" class="row-item prompt-row">
              <span class="mono row-name">{{ prompt.name }}.md</span>
              <Badge variant="accent" class="version-pill mono">v{{ prompt.current_version }}</Badge>
            </div>
          </div>
        </div>
      </section>

      <!-- 目录信息 -->
      <section class="card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:folder-tree" width="16" /></span>
          <div class="card-titles">
            <h3>UniBot 目录</h3>
            <p>扩展的发布目标与平台数据位置</p>
          </div>
          <Button size="sm" @click="dirSetupOpen = true">
            <Icon icon="lucide:pencil" width="13" /> 修改目录
          </Button>
        </header>
        <div class="card-body">
          <div
            v-if="settings && settings.unibot_configured === false"
            class="dir-warn"
            role="note"
          >
            <Icon icon="lucide:triangle-alert" width="15" />
            <span>
              当前目录为启动时自动探测，尚未由你确认。发布扩展前请先设置 UniBot 根目录。
            </span>
          </div>
          <dl class="info-grid">
            <dt>UniBot 目录</dt>
            <dd>
              <span class="mono dir-cell">
                {{ settings?.unibot_dir ?? store.status?.unibot_dir ?? '未设置' }}
              </span>
              <Badge v-if="settings?.unibot_configured" variant="success">已确认</Badge>
              <Badge v-else variant="warning">待确认</Badge>
            </dd>
            <dt>扩展目录</dt>
            <dd class="mono">{{ settings?.extensions_dir ?? store.status?.extensions_dir }}</dd>
            <dt>平台数据</dt>
            <dd class="mono">{{ settings?.data_dir ?? store.status?.data_dir ?? '~/.unibot-studio' }}</dd>
          </dl>
        </div>
      </section>

      <!-- 插件市场：登录态检测 + GitHub PAT / owner / 仓库可见性 -->
      <section class="card">
        <header class="card-top">
          <span class="card-icon"><Icon icon="lucide:store" width="16" /></span>
          <div class="card-titles">
            <h3>插件市场</h3>
            <p>上传扩展到插件市场需要 GitHub 登录；未登录时按下方指引完成后再上传</p>
          </div>
          <Badge :variant="marketBadge.variant">{{ marketBadge.label }}</Badge>
        </header>
        <div class="card-body">
          <!-- 登录状态 -->
          <div class="item-list">
            <div class="row-item">
              <div class="row-main">
                <div class="row-title">
                  <span>GitHub 登录</span>
                  <Badge :variant="marketStatus?.auth_source ? 'success' : 'danger'">
                    {{
                      marketStatus?.auth_source === 'token'
                        ? `PAT 令牌（…${marketStatus?.token_tail}）`
                        : marketStatus?.auth_source === 'gh'
                          ? 'gh 已登录'
                          : '未登录'
                    }}
                  </Badge>
                </div>
                <small class="row-note">
                  git 身份 {{ marketStatus?.git_configured ? '已配置' : '未配置' }} · gh CLI
                  {{
                    marketStatus?.gh_available
                      ? marketStatus?.gh_authed
                        ? '已登录'
                        : '未登录'
                      : '未安装'
                  }}
                </small>
              </div>
            </div>
          </div>

          <!-- 未就绪引导 -->
          <div v-if="marketStatus && !marketStatus.ready && marketStatus.guidance" class="market-guide">
            <Icon icon="lucide:info" width="14" />
            <pre class="market-guide-text">{{ marketStatus.guidance }}</pre>
          </div>

          <!-- 配置表单 -->
          <div class="market-form">
            <label class="field">
              <span class="field-label">GitHub 账号（owner）</span>
              <Input v-model="marketOwner" placeholder="自动检测；组织账号可手动填写" />
            </label>
            <label class="field">
              <span class="field-label">Personal Access Token（可选，留空保持原样）</span>
              <Input v-model="marketToken" type="password" placeholder="ghp_…（需 repo 与 workflow 权限）" />
            </label>
            <label class="field">
              <span class="field-label">扩展仓库可见性</span>
              <Select
                v-model="marketVisibility"
                :options="[
                  { value: 'public', label: '公开（public）' },
                  { value: 'private', label: '私有（private）' },
                ]"
              />
            </label>
            <div class="form-actions">
              <Button variant="primary" size="sm" :loading="marketSaving" @click="saveMarketConfig">
                <Icon icon="lucide:save" width="14" /> {{ marketSaving ? '保存中…' : '保存市场配置' }}
              </Button>
            </div>
          </div>

          <small class="row-note">
            市场仓库：{{ marketStatus?.market_repo ?? 'MineJPGcraft/UniBot.Market' }}（注册表所在地）；token 仅存本机配置，接口永不下发明文。
          </small>
        </div>
      </section>
      </div>
    </main>

    <!-- UniBot 目录设置对话框 -->
    <UnibotDirSetupDialog
      v-model:open="dirSetupOpen"
      :current-dir="settings?.unibot_dir ?? store.status?.unibot_dir ?? ''"
      :onboarding="false"
      @saved="onUnibotDirSaved"
    />

    <!-- 添加 OpenAI 兼容提供商对话框 -->
    <CustomProviderDialog v-model="providerDialogOpen" />
  </div>
</template>

<style scoped>
.admin-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: var(--topbar-height);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
  background: var(--surface);
}

.title {
  font-weight: 600;
  font-size: var(--text-md);
  letter-spacing: -0.01em;
}

.spacer {
  flex: 1;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.content {
  /* 滚动容器保持全宽：滚动条贴窗口右缘；内容限宽由内层负责 */
  flex: 1;
  overflow-y: auto;
}

.content-inner {
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* 页头：大标题 + 描述，与卡片流保持呼吸感 */
.page-head {
  padding: var(--space-2) var(--space-2) 0;
}

.page-head h1 {
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.3;
}

.page-head p {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  color: var(--text-muted);
}

/* ---- 卡片：图标头 + 分隔线 + 内容区 ---- */
.card {
  /* 滚动容器内的 flex 子项：禁止收缩，否则会被压缩而不是撑开滚动条
     （overflow 非 visible 时自动最小尺寸为 0，内容会被裁掉） */
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--shadow);
  overflow: hidden;
  transition:
    box-shadow var(--transition),
    border-color var(--transition);
}

.card:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
}

/* 功能开关卡片：蓝色顶部指示 */
.card.feature-card {
  border-top: 2px solid var(--accent);
}

/* 提供商卡片：紫色顶部指示 */
.card.provider-card {
  border-top: 2px solid #8b5cf6;
}

/* 工具卡片：橙色顶部指示 */
.card.tools-card {
  border-top: 2px solid var(--warning);
}

.card-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--surface-sunken);
}

.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent);
}

.card-titles {
  flex: 1;
  min-width: 0;
}

.card-titles h3 {
  margin: 0;
  font-size: var(--text-base);
  font-weight: 600;
}

.card-titles p {
  margin-top: 1px;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.card-body {
  padding: var(--space-4) var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* ---- 功能开关行 ---- */
.feature-item {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  cursor: pointer;
  padding: var(--space-3);
  border-radius: var(--radius);
  transition: background-color var(--transition);
}

.feature-item:hover {
  background: var(--surface-sunken);
}

.feature-item.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.feature-text span {
  display: block;
  font-size: var(--text-sm);
  font-weight: 500;
}

.feature-text small {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

/* ---- 通用列表行（提供商 / 工具 / 提示词） ---- */
.item-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.row-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition:
    border-color var(--transition),
    background-color var(--transition);
}

.row-item:hover {
  border-color: var(--border-strong);
  background: var(--surface-sunken);
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}

.row-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.row-name {
  font-size: var(--text-sm);
  font-weight: 500;
}

.row-id {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.row-note {
  color: var(--text-secondary);
  font-size: var(--text-xs);
  word-break: break-all;
}

/* 模型 ID chips（超出 8 个折叠为 +N） */
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.chip {
  padding: 1px var(--space-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.6;
}

.chip.more {
  background: var(--surface-sunken);
  color: var(--text-muted);
}

/* 提供商空态 / 加载失败 */
.provider-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.provider-empty.danger {
  color: var(--danger);
  border-color: #fecaca;
  background: var(--danger-soft);
}

.link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
}

/* 提示词行：名称居左，版本徽章贴右 */
.prompt-row {
  padding: var(--space-3) var(--space-4);
}

.prompt-row .row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-pill {
  flex-shrink: 0;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: 999px;
  font-size: var(--text-xs);
}

/* ---- UniBot 目录 ---- */
.dir-warn {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  border-radius: var(--radius);
  font-size: var(--text-sm);
  color: #92400e;
  line-height: 1.5;
}

.dir-warn svg {
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--warning);
}

.info-grid {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: var(--space-3) var(--space-4);
  margin: 0;
  font-size: var(--text-sm);
}

.info-grid dt {
  color: var(--text-muted);
  padding-top: 2px;
}

.info-grid dd {
  margin: 0;
  word-break: break-all;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  color: var(--text-secondary);
}

.dir-cell {
  color: var(--text);
}

/* ---- 插件市场 ---- */
.market-guide {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--warning-soft);
  border: 1px solid #fde68a;
  border-radius: var(--radius);
}

.market-guide svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

.market-guide-text {
  margin: 0;
  font-size: var(--text-xs);
  color: #92400e;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.market-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-label {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
}

/* ---- 主题切换 ---- */
.theme-options {
  display: flex;
  gap: var(--space-2);
}

.theme-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    border-color var(--transition),
    background var(--transition),
    color var(--transition);
}

.theme-btn:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.theme-btn.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
</style>
