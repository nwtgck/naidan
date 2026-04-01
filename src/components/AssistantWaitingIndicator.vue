<script setup lang="ts">
withDefaults(defineProps<{
  isNested?: boolean;
  noPadding?: boolean;
}>(), {
  isNested: false,
  noPadding: false
});

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div
    class="flex items-center gap-2"
    :class="[
      noPadding ? '' : 'py-2',
      (isNested && !noPadding) ? 'px-5' : ''
    ]"
    data-testid="assistant-waiting-indicator"
  >
    <!-- Three breathing orbs with staggered phase -->
    <div class="wi-orbs" aria-hidden="true">
      <span class="wi-orb wi-o1" />
      <span class="wi-orb wi-o2" />
      <span class="wi-orb wi-o3" />
    </div>
    <span class="text-[10px] font-bold tracking-tight text-gray-400 dark:text-gray-500 select-none">Waiting for response...</span>
  </div>
</template>

<style scoped>
.wi-orbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wi-orb {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  animation: wi-breathe 1.2s ease-in-out infinite;
}

/* Left to right: dim→mid→bright, matching the direction of text flow */
.wi-o1 { background: #93c5fd; animation-delay: 0s;   }
.wi-o2 { background: #60a5fa; animation-delay: 0.2s; }
.wi-o3 { background: #3b82f6; animation-delay: 0.4s; }

@keyframes wi-breathe {
  0%, 100% {
    transform: scale(0.55);
    opacity: 0.4;
    box-shadow: 0 0 0px 0px rgba(96, 165, 250, 0);
  }
  50% {
    transform: scale(1);
    opacity: 1;
    box-shadow: 0 0 6px 2px rgba(96, 165, 250, 0.5);
  }
}
</style>
