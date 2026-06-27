<script setup lang="ts">
import MainLayoutFrame from '@/components/layout/MainLayoutFrame.vue';

/**
 * WHY: Showing the eventual layout behind onboarding makes the close action
 * predictable, but starting the real chat/router tree in parallel would create
 * a second timing-sensitive startup path. Keep this component visual-only.
 */


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  }
});
</script>

<template>
  <MainLayoutFrame
    sidebar-width="expanded"
    data-testid="main-layout-preview"
  >
    <template #sidebar>
      <div class="h-full bg-white dark:bg-gray-900 p-4 space-y-4" aria-hidden="true">
        <div class="h-8 rounded-lg bg-gray-100 dark:bg-gray-800" />
        <div class="space-y-2 pt-2">
          <div class="h-7 rounded-lg bg-gray-100/80 dark:bg-gray-800/80" />
          <div class="h-7 rounded-lg bg-gray-100/80 dark:bg-gray-800/80" />
          <div class="h-7 rounded-lg bg-gray-100/80 dark:bg-gray-800/80" />
        </div>
      </div>
    </template>

    <template #main>
      <div class="h-full flex flex-col bg-gray-50/50 dark:bg-gray-950" aria-hidden="true">
        <div class="h-14 border-b border-gray-100 dark:border-gray-800" />
        <div class="flex-1" />
        <div class="mx-auto mb-6 h-14 w-[min(42rem,calc(100%-3rem))] rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900" />
      </div>
    </template>
  </MainLayoutFrame>
</template>
