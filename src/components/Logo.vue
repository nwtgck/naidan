<script setup lang="ts">
interface Props {
  size?: number;
  className?: string;
}
withDefaults(defineProps<Props>(), {
  size: 32,
  className: '',
});
</script>

<template>
  <div 
    :style="{ 
      width: size + 'px', 
      height: size + 'px', 
      backgroundColor: 'currentColor',
      maskImage: `url('./logo.svg')`,
      maskRepeat: 'no-repeat',
      maskPosition: 'center',
      maskSize: 'contain',
      WebkitMaskImage: `url('./logo.svg')`,
      WebkitMaskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      WebkitMaskSize: 'contain'
    }"
    :class="className"
    class="text-blue-600 dark:text-blue-400 transition-transform duration-300 hover:scale-110"
    role="img"
    aria-label="Naidan Logo"
  />
</template>

<style scoped>
/* 
  Using mask-image allows us to use an external SVG file as a source of truth 
  for the shape, while still controlling the color via CSS 'currentColor'.
  This ensures perfect dark mode support without complex filters.
*/
</style>