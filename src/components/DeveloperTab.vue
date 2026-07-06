<script setup lang="ts">
import { useSampleChat } from '@/composables/useSampleChat';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { CpuIcon, FlaskConicalIcon, RefreshCwIcon, ScrollTextIcon } from 'lucide-vue-next';
import FeatureFlagsSettings from './FeatureFlagsSettings.vue';
import DeveloperOpenStateLinks from './DeveloperOpenStateLinks.vue';
import DeveloperDataDeletionPanel from '@/features/data-deletion/components/DeveloperDataDeletionPanel.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  storageType: string,
}>();

const { createSampleChat, createLongSampleChat } = useSampleChat();
const { needRefresh, setNeedRefresh } = usePWAUpdate();

function togglePWAUpdate() {
  setNeedRefresh({
    refresh: !needRefresh.value,
    handler: !needRefresh.value ? async () => {
      console.log('PWA Update triggered via Developer Tab');
      window.location.reload();
    } : undefined,
  });
}


function handleReload() {
  window.location.reload();
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="developer-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-8 duration-400">
    <section tw-class="space-y-8">
      <div tw-class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <CpuIcon tw-class="w-5 h-5 text-blue-500" />
        <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.DeveloperTab__developer_tools() }}</h2>
      </div>

      <div tw-class="space-y-8">
        <div tw-class="space-y-4">
          <h3 tw-class="text-sm font-bold text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.DeveloperTab__experimental_features() }}</h3>
          <FeatureFlagsSettings />
        </div>

        <div tw-class="space-y-4">
          <h3 tw-class="text-sm font-bold text-gray-500 uppercase tracking-widest ml-1">{{ lazyStrings.DeveloperTab__debug_and_testing() }}</h3>
          <div tw-class="flex flex-col gap-2 sm:flex-row">
            <button
              @click="createSampleChat"
              tw-class="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm font-bold text-gray-700 shadow-sm transition-all hover:bg-gray-100 active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="setting-create-sample-button"
            >
              <FlaskConicalIcon tw-class="h-4 w-4" />
              {{ lazyStrings.DeveloperTab__create_sample_chat() }}
            </button>
            <button
              @click="createLongSampleChat"
              tw-class="flex flex-1 items-center justify-center gap-2 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm font-bold text-gray-700 shadow-sm transition-all hover:bg-gray-100 active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="setting-create-long-sample-button"
            >
              <ScrollTextIcon tw-class="h-4 w-4" />
              {{ lazyStrings.DeveloperTab__create_long_sample_chat() }}
            </button>
          </div>
          <p tw-class="text-[11px] font-medium text-gray-400 ml-1">{{ lazyStrings.DeveloperTab__sample_conversations_description() }}</p>
        </div>

        <DeveloperOpenStateLinks />

        <div tw-class="space-y-2">
          <button
            @click="togglePWAUpdate"
            :tw-class="['w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95 text-left', { 'ring-2 ring-emerald-500/20 border-emerald-500/50 bg-emerald-50/30 dark:bg-emerald-900/10': needRefresh }]"
            data-testid="toggle-pwa-update-button"
          >
            <div tw-class="flex items-center gap-2">
              <div tw-class="p-1.5 bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-100 dark:border-gray-800">
                <RefreshCwIcon :class="needRefresh ? 'animate-spin-slow' : ''" :tw-class="['w-4 h-4', needRefresh ? 'text-emerald-500' : 'text-gray-400']" />
              </div>
              <div tw-class="flex flex-col">
                <span tw-class="text-sm font-bold">{{ lazyStrings.DeveloperTab__simulate_pwa_update() }}</span>
                <span tw-class="text-[10px] font-medium text-gray-500">{{ lazyStrings.DeveloperTab__toggle_update_notification() }}</span>
              </div>
            </div>
            <div v-if="needRefresh" tw-class="flex h-2 w-2 relative">
              <span tw-class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span tw-class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </div>
          </button>


          <button
            @click="handleReload"
            tw-class="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95 text-left"
            data-testid="reload-app-button"
          >
            <div tw-class="flex items-center gap-2">
              <div tw-class="p-1.5 bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-100 dark:border-gray-800">
                <RefreshCwIcon tw-class="w-4 h-4 text-gray-400" />
              </div>
              <div tw-class="flex flex-col">
                <span tw-class="text-sm font-bold">{{ lazyStrings.DeveloperTab__reload_application() }}</span>
                <span tw-class="text-[10px] font-medium text-gray-500">{{ lazyStrings.DeveloperTab__perform_window_reload() }}</span>
              </div>
            </div>
          </button>
        </div>

        <DeveloperDataDeletionPanel :storage-type="props.storageType" />
      </div>
    </section>
  </div>
</template>

<style scoped>
@keyframes spin-slow {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.animate-spin-slow {
  animation: spin-slow 8s linear infinite;
}
</style>
