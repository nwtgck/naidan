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
  <svg 
    :width="size" 
    :height="size" 
    viewBox="0 0 24 24" 
    fill="none" 
    xmlns="http://www.w3.org/2000/svg"
    :class="className"
    class="transition-transform duration-300 hover:scale-110"
  >
    <!-- Geometric Bird / Wing Shape -->
    <path 
      d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" 
      class="fill-indigo-600/10 dark:fill-indigo-400/10"
    />
    <path 
      d="M17.5 7.5L9 12L17.5 16.5L15 12L17.5 7.5Z" 
      class="fill-indigo-600 dark:fill-indigo-400"
      stroke="currentColor" 
      stroke-width="0.5" 
      stroke-linejoin="round"
    />
    <path 
      d="M6.5 12L15 7.5L12.5 12L15 16.5L6.5 12Z" 
      class="fill-indigo-500 dark:fill-indigo-300"
      stroke="currentColor" 
      stroke-width="0.5" 
      stroke-linejoin="round"
    />
    <circle cx="10" cy="12" r="1" fill="white" class="opacity-80" />
  </svg>
</template>
