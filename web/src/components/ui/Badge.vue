<script setup>
defineProps({
  variant: { type: String, default: 'neutral' }, // neutral | success | warning | danger | accent
})
</script>

<template>
  <span class="ui-badge" :class="`ui-badge--${variant}`">
    <slot />
  </span>
</template>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 20px;
  padding: 0 var(--space-2);
  border-radius: 4px;
  font-size: var(--text-xs);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  letter-spacing: 0.01em;
}

.ui-badge--neutral {
  background: rgb(0 0 0 / 0.05);
  color: var(--text-secondary);
}

.ui-badge--success {
  background: var(--success-soft);
  color: var(--success);
  border: 1px solid rgb(22 163 74 / 0.12);
}

.ui-badge--warning {
  background: var(--warning-soft);
  color: var(--warning);
  border: 1px solid rgb(217 119 6 / 0.12);
}

.ui-badge--danger {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid rgb(220 38 38 / 0.12);
}

.ui-badge--accent {
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid rgb(37 99 235 / 0.12);
}
</style>
