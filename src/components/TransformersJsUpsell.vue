<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { BrainCircuitIcon, PlusIcon } from 'lucide-vue-next';

defineProps<{
  show?: boolean,
}>();


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div v-if="show" class="mt-4 animate-in fade-in slide-in-from-top-2 duration-400">
    <div class="p-4 bg-purple-50/50 dark:bg-purple-900/10 border border-dashed border-purple-200 dark:border-purple-800/40 rounded-2xl flex flex-col gap-3 shadow-sm">
      <div class="flex items-start gap-3">
        <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-purple-100 dark:border-purple-900/20 shrink-0">
          <BrainCircuitIcon class="w-4 h-4 text-purple-600" />
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[11px] font-bold text-purple-900 dark:text-purple-300">{{ lazyStrings.TransformersJsUpsell__local_browser_models() }}</p>
          <p class="text-[10px] text-purple-600/70 dark:text-purple-400/70 font-medium leading-relaxed">
            {{ lazyStrings.TransformersJsUpsell__need_more_models_you_can_download_and_manage_local_llms_to_run_directly_in_your_browser() }}
          </p>
        </div>
      </div>
      <router-link
        :to="{ query: { ...$route.query, settings: 'transformers-js' } }"
        class="flex items-center justify-center gap-2 w-full py-2 bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-bold rounded-xl shadow-lg shadow-purple-500/20 transition-all active:scale-[0.98] group"
      >
        <PlusIcon class="w-3 h-3 group-hover:rotate-90 transition-transform duration-300" />
        <span>{{ lazyStrings.TransformersJsUpsell__add_manage_models() }}</span>
      </router-link>
    </div>
  </div>
</template>
