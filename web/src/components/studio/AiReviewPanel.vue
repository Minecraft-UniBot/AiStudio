<script setup>
// AI 审核结果（Plan 3.5：问题分级展示；技术详情收起）
import { computed } from 'vue'
import { Icon } from '@iconify/vue'

const props = defineProps({
  review: { type: Object, default: null },
})

const visibleIssues = computed(() => props.review?.issues ?? [])

function severityIcon(severity) {
  if (severity === 'passed') return 'lucide:check-circle-2'
  if (severity === 'must_fix') return 'lucide:alert-circle'
  return 'lucide:info'
}
</script>

<template>
  <div v-if="review" class="ai-review">
    <div class="result-section">
      <h4>AI 审核结果</h4>
      <p class="review-summary">{{ review.summary }}</p>
      <div v-if="visibleIssues.length" class="issue-list">
        <div
          v-for="issue in visibleIssues"
          :key="issue.id"
          class="issue-item"
          :class="issue.severity"
        >
          <Icon :icon="severityIcon(issue.severity)" width="14" />
          <div class="issue-body">
            <span class="issue-title">{{ issue.title }}</span>
            <span v-if="issue.file" class="issue-file mono">{{ issue.file }}</span>
            <details v-if="issue.detail" class="issue-detail">
              <summary>技术详情</summary>
              <pre>{{ issue.detail }}</pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result-section {
  border-bottom: 1px solid var(--border);
  padding: 14px 0;
}

.result-section h4 {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-secondary);
}

.review-summary {
  margin: 0 0 10px;
  font-size: 13.5px;
  line-height: 1.6;
}

.issue-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.issue-item {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 12.5px;
}

.issue-item.must_fix {
  border-color: #fecaca;
  background: var(--danger-soft);
}

.issue-item.must_fix svg {
  color: var(--danger);
  flex-shrink: 0;
  margin-top: 2px;
}

.issue-item.suggestion {
  border-color: var(--border);
  background: var(--surface);
}

.issue-item.suggestion svg {
  color: var(--accent);
  flex-shrink: 0;
  margin-top: 2px;
}

.issue-item.passed svg {
  color: var(--success);
  flex-shrink: 0;
  margin-top: 2px;
}

.issue-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.issue-title {
  font-weight: 500;
}

.issue-file {
  font-size: 11.5px;
  color: var(--text-muted);
}

.issue-detail summary {
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}

.issue-detail pre {
  margin: 6px 0 0;
  padding: 8px;
  background: var(--surface-sunken);
  border-radius: var(--radius);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
  color: var(--text-secondary);
}
</style>
