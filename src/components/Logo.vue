<script setup lang="ts">
import logoUrl from '../assets/logo.svg';

interface Props {
  size?: number;
  className?: string;
}
withDefaults(defineProps<Props>(), {
  size: 32,
  className: '',
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="relative flex items-center justify-center group" :style="{ width: size + 'px', height: size + 'px' }">
    <!-- Vibrant Glow Effect -->
    <div 
      class="absolute inset-0 bg-sky-400/30 dark:bg-blue-400/20 blur-2xl rounded-full scale-150 opacity-0 group-hover:opacity-100 transition-all duration-700"
    ></div>

    <!-- Standard img tag for perfect SVG rendering -->
    <!-- Vite will inline the logoUrl as a Base64 string for file:// compatibility -->
    <img 
      :src="logoUrl"
      :width="size"
      :height="size"
      :style="{ width: size + 'px', height: size + 'px' }"
      class="relative z-10 transition-all duration-500 hover:scale-110 hover:brightness-110"
      :class="className"
      alt="Naidan Logo"
    />
  </div>
</template>
