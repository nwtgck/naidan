<script setup lang="ts">
import { useTheme } from '../composables/useTheme';
import { Sun, Moon, Monitor } from 'lucide-vue-next';

const { themeMode, setTheme } = useTheme();


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="relative flex items-center bg-gray-200 dark:bg-black p-0.5 rounded-xl border border-gray-300 dark:border-gray-800 shadow-[inset_0_2px_4px_rgba(0,0,0,0.15)] w-full">
    <!-- Sliding Indicator (Solid Convex Plate Look) -->
    <div
      data-testid="theme-indicator"
      class="absolute top-0.5 bottom-0.5 left-0.5 w-[calc(33.333%-0.666px)] bg-white dark:bg-gray-700 rounded-lg shadow-[0_2px_0_rgba(0,0,0,0.05),0_4px_6px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_10px_rgba(0,0,0,0.5)] border border-gray-200 dark:border-gray-600 transition-transform duration-300 ease-in-out"
      :style="{
        transform: themeMode === 'light' ? 'translateX(0)' :
          themeMode === 'dark' ? 'translateX(100%)' :
          'translateX(200%)'
      }"
    >
    </div>

    <button
      @click="setTheme('light')"
      class="relative z-10 flex-1 flex justify-center py-1.5 rounded-lg transition-colors duration-300"
      :class="themeMode === 'light' ? 'text-blue-600 dark:text-yellow-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
      title="Light Mode"
    >
      <Sun class="w-3.5 h-3.5" />
    </button>
    <button
      @click="setTheme('dark')"
      class="relative z-10 flex-1 flex justify-center py-1.5 rounded-lg transition-colors duration-300"
      :class="themeMode === 'dark' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
      title="Dark Mode"
    >
      <Moon class="w-3.5 h-3.5" />
    </button>
    <button
      @click="setTheme('system')"
      class="relative z-10 flex-1 flex justify-center py-1.5 rounded-lg transition-colors duration-300"
      :class="themeMode === 'system' ? 'text-blue-600 dark:text-green-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
      title="System Mode"
    >
      <Monitor class="w-3.5 h-3.5" />
    </button>
  </div>
</template>
