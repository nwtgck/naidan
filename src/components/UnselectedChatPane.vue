<script setup lang="ts">
import { useLayout } from '@/composables/useLayout';

const { setActiveFocusArea } = useLayout();


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div
    class="flex h-full items-center justify-center bg-[#fcfcfd] text-gray-400 transition-colors dark:bg-gray-900 dark:text-gray-500"
    @click="setActiveFocusArea({ area: 'chat' })"
  >
    Select or create a chat to start
  </div>
</template>
