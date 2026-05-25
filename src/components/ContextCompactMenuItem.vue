<script setup lang="ts">
import { Minimize2Icon } from 'lucide-vue-next';

defineEmits<{
  (e: 'compact'): void;
}>();

defineExpose({
  TEST_ONLY: {},
});
</script>

<template>
  <button
    class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
    data-testid="compact-context-button"
    @click="$emit('compact')"
  >
    <Minimize2Icon class="w-4 h-4" />
    <span>Compact Context</span>
  </button>
</template>
