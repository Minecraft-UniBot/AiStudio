<script setup>
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
} from 'reka-ui'

defineProps({
  text: { type: String, required: true },
})
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent class="ui-tooltip-content" :side-offset="6">
          {{ text }}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style scoped>
.ui-tooltip-content {
  position: relative;
  padding: var(--space-1) var(--space-2);
  background: var(--text);
  color: #ffffff;
  border-radius: var(--radius);
  font-size: var(--text-xs);
  box-shadow: var(--shadow-md);
  z-index: var(--z-tooltip);
  animation: tooltip-in 120ms ease-out;
}

@keyframes tooltip-in {
  from {
    opacity: 0;
  }
}
</style>
