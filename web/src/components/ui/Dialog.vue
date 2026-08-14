<script setup>
import {
  DialogRoot,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'reka-ui'
import Button from './Button.vue'

const open = defineModel({ type: Boolean, default: false })

defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  confirmText: { type: String, default: '确认' },
  cancelText: { type: String, default: '取消' },
  confirmVariant: { type: String, default: 'primary' },
  loading: { type: Boolean, default: false },
  hideFooter: { type: Boolean, default: false },
  width: { type: String, default: 'min(480px, calc(100vw - 32px))' },
})

defineEmits(['confirm'])
</script>

<template>
  <DialogRoot :open="open" @update:open="(value) => (open = value)">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay" />
      <DialogContent
        class="ui-dialog-content"
        :style="{ width }"
        :aria-describedby="description ? 'dialog-description' : undefined"
      >
        <DialogTitle class="ui-dialog-title">{{ title }}</DialogTitle>
        <DialogDescription v-if="description" id="dialog-description" class="ui-dialog-description">
          {{ description }}
        </DialogDescription>
        <div class="ui-dialog-body">
          <slot />
        </div>
        <div v-if="!hideFooter" class="ui-dialog-footer">
          <DialogClose as-child>
            <Button variant="ghost">{{ cancelText }}</Button>
          </DialogClose>
          <Button :variant="confirmVariant" :loading="loading" @click="$emit('confirm')">
            {{ confirmText }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgb(24 24 27 / 0.45);
  z-index: var(--z-overlay);
  animation: overlay-fade-in 150ms ease-out;
}

.ui-dialog-content {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-height: 85vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-6);
  z-index: var(--z-dialog);
  animation: dialog-pop-in 180ms ease-out;
}

.ui-dialog-content:focus {
  outline: none;
}

.ui-dialog-title {
  font-size: var(--text-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.ui-dialog-description {
  margin-top: var(--space-1);
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.ui-dialog-body {
  margin-top: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.ui-dialog-footer {
  margin-top: var(--space-6);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

@keyframes overlay-fade-in {
  from {
    opacity: 0;
  }
}

@keyframes dialog-pop-in {
  from {
    opacity: 0;
    transform: translate(-50%, -48%) scale(0.97);
  }
}
</style>
