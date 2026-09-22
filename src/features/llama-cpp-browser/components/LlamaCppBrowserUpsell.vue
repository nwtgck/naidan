<script setup lang="ts">
import { FileUpIcon, FolderOpenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
defineProps<{ show: boolean }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="show" tw-class="mt-4 p-4 rounded-2xl border border-dashed border-purple-200 dark:border-purple-800/40 bg-purple-50/50 dark:bg-purple-900/10 space-y-3 shadow-sm" data-testid="llama-cpp-browser-upsell">
    <div tw-class="flex items-start gap-3">
      <div tw-class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-purple-100 dark:border-purple-900/20 shrink-0">
        <FileUpIcon tw-class="w-4 h-4 text-purple-600 dark:text-purple-400" />
      </div>
      <div tw-class="min-w-0 flex-1">
        <p tw-class="text-[11px] font-bold text-purple-900 dark:text-purple-300">{{ lazyStrings.llamaCppBrowser__gguf_model_files() }}</p>
        <p tw-class="text-[10px] font-medium leading-relaxed text-purple-600/70 dark:text-purple-400/70">{{ lazyStrings.llamaCppBrowser__import_downloaded_gguf() }}</p>
      </div>
    </div>
    <router-link
      :to="{ query: { ...$route.query, settings: 'llama-cpp-browser' } }"
      tw-class="flex items-center justify-center gap-2 w-full py-2 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-bold shadow-lg shadow-purple-500/20 transition-all active:scale-[0.98]"
    >
      <FolderOpenIcon tw-class="w-3 h-3" />
      <span>{{ lazyStrings.llamaCppBrowser__manage_gguf_models() }}</span>
    </router-link>
  </div>
</template>
