<script setup lang="ts">
import { FolderOpen } from 'lucide-vue-next';


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex flex-col items-center justify-center flex-1 text-gray-300 dark:text-gray-700 select-none py-16" data-testid="file-explorer-empty">
    <FolderOpen class="w-12 h-12 mb-3 opacity-40" />
    <p class="text-xs font-bold uppercase tracking-widest opacity-60">Empty Folder</p>
  </div>
</template>
