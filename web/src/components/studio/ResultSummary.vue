<script setup>
// 功能结果摘要（Plan 3.4 右栏「功能」Tab）：扩展信息 + 机械校验状态 + 发布入口
import { computed } from 'vue'
import { Icon } from '@iconify/vue'
import { TYPE_LABELS, STATUS_LABELS } from '@/utils/draft_status'
import Button from '@/components/ui/Button.vue'
import Badge from '@/components/ui/Badge.vue'

const props = defineProps({
  draft: { type: Object, required: true },
  canPublish: { type: Boolean, default: false },
  publishing: { type: Boolean, default: false },
})

const emit = defineEmits(['publish', 'market'])

const types = computed(() => props.draft.types.map((type) => TYPE_LABELS[type]).filter(Boolean))
const statusLabel = computed(() => STATUS_LABELS[props.draft.status] ?? props.draft.status)

/** 草稿当前所处阶段对应的徽章变体 */
const statusVariant = computed(() => {
  switch (props.draft.status) {
    case 'published':
      return 'success'
    case 'ready':
      return 'success'
    case 'planning':
    case 'coding':
      return 'accent'
    default:
      return 'neutral'
  }
})

/** 校验状态文案与图标 */
const validation = computed(() => {
  const v = props.draft.validation
  if (!v) return null
  switch (v.status) {
    case 'passed':
      return { icon: 'lucide:shield-check', label: '机械校验通过', tone: 'passed' }
    case 'failed':
      return { icon: 'lucide:shield-x', label: '机械校验未通过', tone: 'failed' }
    case 'running':
      return { icon: 'lucide:loader-2', label: '机械校验进行中…', tone: 'running', spin: true }
    default:
      return null
  }
})

/** 发布是否被锁定，以及锁定原因提示 */
const canPublishHint = computed(() => {
  const status = props.draft.status
  if (status === 'published') return '已发布，草稿为只读'
  if (props.draft.error) return '机械校验未通过，暂时无法发布（见顶部错误提示）'
  if (status !== 'ready') return '编码完成且机械校验通过后即可发布'
  return ''
})

/** 是否处于「编码 / 校验进行中」的空气态（占位展示，避免空白） */
const inProgress = computed(() => ['planning', 'coding'].includes(props.draft.status))
const inProgressText = computed(() =>
  props.draft.status === 'coding' ? '编码与机械校验进行中…' : 'AI 正在规划实现方案…',
)
</script>

<template>
  <div class="result-summary">
    <!-- 扩展信息卡：图标 + 名称 + ID + 状态徽章 -->
    <section class="ext-card">
      <div class="ext-card-head">
        <div class="ext-icon">
          <Icon icon="lucide:puzzle" width="22" />
        </div>
        <div class="ext-head-main">
          <h3 class="ext-name">{{ draft.name }}</h3>
          <div class="ext-meta">
            <span class="mono ext-id">{{ draft.extension_id }}</span>
            <Badge :variant="statusVariant" class="ext-status">{{ statusLabel }}</Badge>
          </div>
        </div>
      </div>
      <p v-if="draft.description" class="ext-desc">{{ draft.description }}</p>
      <div v-if="types.length" class="ext-types">
        <Badge v-for="t in types" :key="t" variant="accent" class="ext-type">{{ t }}</Badge>
      </div>
    </section>

    <!-- 校验 / 进度状态 -->
    <section v-if="inProgress" class="status-card working">
      <Icon icon="lucide:loader-2" width="18" class="spin status-icon" />
      <div class="status-body">
        <span class="status-title">{{ inProgressText }}</span>
        <span class="status-sub">完成后会自动进入可发布状态</span>
      </div>
    </section>
    <section v-else-if="validation" class="status-card" :class="validation.tone">
      <Icon :icon="validation.icon" width="18" class="status-icon" :class="{ spin: validation.spin }" />
      <div class="status-body">
        <span class="status-title">{{ validation.label }}</span>
        <span v-if="validation.tone === 'passed'" class="status-sub">可以发布到 UniBot</span>
        <span v-else-if="validation.tone === 'failed'" class="status-sub">请修复后再发布</span>
      </div>
    </section>

    <!-- 发布 -->
    <section class="publish-card">
      <div class="publish-head">
        <Icon icon="lucide:rocket" width="16" class="publish-icon" />
        <span class="publish-title">发布到 UniBot</span>
      </div>
      <Button
        variant="primary"
        class="publish-btn"
        :disabled="!canPublish || publishing"
        :loading="publishing"
        @click="emit('publish')"
      >
        <Icon v-if="!publishing" icon="lucide:rocket" width="15" />
        {{ publishing ? '发布中…' : '一键发布到 UniBot' }}
      </Button>
      <p class="publish-hint">
        <Icon icon="lucide:info" width="13" />
        {{ canPublishHint || '发布采用原子交付；目标 ID 已存在时拒绝覆盖。' }}
      </p>
    </section>

    <!-- 上传插件市场：生成仓库 → GitHub Release → 市场注册 PR（git/gh 命令行驱动） -->
    <section class="publish-card">
      <div class="publish-head">
        <Icon icon="lucide:store" width="16" class="publish-icon" />
        <span class="publish-title">上传到插件市场</span>
      </div>
      <Button
        variant="secondary"
        class="publish-btn"
        :disabled="!canPublish"
        @click="emit('market')"
      >
        <Icon icon="lucide:store" width="15" />
        上传到插件市场
      </Button>
      <p class="publish-hint">
        <Icon icon="lucide:info" width="13" />
        按 Extension.Example 模板生成仓库并推送到 GitHub，创建 Release 后向市场提交注册 PR。
      </p>
      <p v-if="draft.market" class="market-status">
        <Icon
          :icon="
            draft.market.status === 'submitted'
              ? 'lucide:check-circle-2'
              : draft.market.status === 'failed'
                ? 'lucide:x-circle'
                : 'lucide:loader-2'
          "
          width="13"
          :class="{ spin: draft.market.status === 'running' }"
        />
        {{
          draft.market.status === 'submitted'
            ? '已提交市场 PR'
            : draft.market.status === 'failed'
              ? '上次上传失败，点击重新上传'
              : '市场上传进行中…'
        }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.result-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* ---------- 扩展信息卡 ---------- */
.ext-card {
  padding: var(--space-4);
  background:
    linear-gradient(135deg, var(--accent-soft) 0%, transparent 60%),
    var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
}

.ext-card-head {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
}

.ext-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--accent);
  box-shadow: var(--shadow);
}

.ext-head-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ext-name {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
  word-break: break-word;
}

.ext-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.ext-id {
  font-size: var(--text-xs);
  color: var(--text-muted);
  padding: 2px var(--space-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.ext-status {
  flex-shrink: 0;
}

.ext-desc {
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  word-break: break-word;
}

.ext-types {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-3);
}

.ext-type {
  font-size: 11px;
}

/* ---------- 状态卡 ---------- */
.status-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid;
}

.status-icon {
  flex-shrink: 0;
}

.status-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.status-title {
  font-size: var(--text-sm);
  font-weight: 600;
  line-height: 1.4;
}

.status-sub {
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.status-card.passed {
  color: var(--success);
  background: var(--success-soft);
  border-color: #bbf7d0;
}

.status-card.passed .status-title {
  color: var(--success);
}

.status-card.passed .status-icon {
  color: var(--success);
}

.status-card.failed {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: #fecaca;
}

.status-card.failed .status-title {
  color: var(--danger);
}

.status-card.failed .status-icon {
  color: var(--danger);
}

.status-card.working {
  color: var(--text-secondary);
  background: var(--surface-sunken);
  border-color: var(--border);
}

.status-card.working .status-icon {
  color: var(--accent);
}

.status-card.running {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: #bfdbfe;
}

.status-card.running .status-title {
  color: var(--accent);
}

.status-card.running .status-icon {
  color: var(--accent);
}

/* ---------- 发布卡 ---------- */
.publish-card {
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
}

.publish-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.publish-icon {
  color: var(--accent);
}

.publish-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}

.publish-btn {
  width: 100%;
  justify-content: center;
}

.publish-hint {
  display: flex;
  align-items: flex-start;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  line-height: 1.5;
}

.publish-hint svg {
  flex-shrink: 0;
  margin-top: 2px;
}

.market-status {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}

.market-status svg {
  flex-shrink: 0;
}

.market-status svg.spin {
  color: var(--accent);
}

/* ---------- 动画 ---------- */
.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
