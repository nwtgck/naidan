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
  <div class="relative flex items-center justify-center group">
    <!-- Vibrant Glow Effect -->
    <div 
      class="absolute inset-0 bg-sky-400/30 dark:bg-blue-400/20 blur-2xl rounded-full scale-150 opacity-0 group-hover:opacity-100 transition-all duration-700"
      :style="{ width: size + 'px', height: size + 'px' }"
    ></div>

    <!-- Crystal-like Gradient Logo with Mask -->
    <div 
      :style="{ 
        width: size + 'px', 
        height: size + 'px', 
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
      class="relative z-10 logo-gradient transition-all duration-500 hover:scale-110 hover:brightness-110"
      role="img"
      aria-label="Naidan Logo"
    />
  </div>
</template>

<style scoped>
.logo-gradient {
  /* High-contrast, crystal-clear gradient from Top-Right to Bottom-Left */
  background: linear-gradient(225deg, #7dd3fc 0%, #3b82f6 50%, #1d4ed8 100%);
}

.dark .logo-gradient {
  /* Extra vibrance for Dark Mode */
  background: linear-gradient(225deg, #bae6fd 0%, #60a5fa 50%, #2563eb 100%);
}
</style>