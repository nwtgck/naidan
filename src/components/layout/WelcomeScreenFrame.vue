<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  placement: 'contained' | 'floating' | 'standalone',
}>();

const floating = computed(() => {
  switch (props.placement) {
  case 'contained':
  case 'standalone':
    return false;
  case 'floating':
    return true;
  default: {
    const _ex: never = props.placement;
    return _ex;
  }
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div :class="{ 'welcome-screen-standalone': placement === 'standalone' }" :tw-class="['flex flex-col items-center justify-center p-6 sm:p-12 text-center pointer-events-none', floating ? 'absolute inset-0' : 'relative w-full min-h-full']">
    <div :class="floating ? 'animate-in fade-in zoom-in' : undefined" :tw-class="['w-full max-w-4xl flex flex-col items-center space-y-8 sm:space-y-12 duration-1000', floating ? 'translate-y-[-25%] sm:translate-y-[-30%]' : '']">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.welcome-screen-standalone {
  padding-block: clamp(2rem, 8dvh, 6rem) clamp(3rem, 16dvh, 10rem);
}
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes zoom-in {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in {
  animation-name: zoom-in;
}
</style>
