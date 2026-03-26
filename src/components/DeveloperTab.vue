<script setup lang="ts">
import { useSampleChat } from '@/composables/useSampleChat';
import { useConfirm } from '@/composables/useConfirm';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { storageService } from '@/services/storage';
import { Cpu, FlaskConical, AlertTriangle, Trash2, RefreshCw } from 'lucide-vue-next';
import FeatureFlagsSettings from './FeatureFlagsSettings.vue';

defineProps<{
  storageType: string;
}>();

const { createSampleChat } = useSampleChat();
const { showConfirm } = useConfirm();
const { needRefresh, setNeedRefresh } = usePWAUpdate();

function togglePWAUpdate() {
  setNeedRefresh({
    refresh: !needRefresh.value,
    handler: !needRefresh.value ? async () => {
      console.log('PWA Update triggered via Developer Tab');
      window.location.reload();
    } : undefined
  });
}

async function handleResetData() {
  const confirmed = await showConfirm({
    title: 'Confirm Data Reset',
    message: 'Are you sure you want to reset all app data? This will delete all chats, chat groups, and settings for the current storage location.',
    confirmButtonText: 'Reset',
    confirmButtonVariant: 'danger',
  });
  if (confirmed) {
    await storageService.clearAll();
    window.location.reload();
  }
}

async function handleClearAllCacheStorage() {
  const confirmed = await showConfirm({
    title: 'Clear All Cache Storage',
    message: 'Are you sure you want to delete all entries in the browser\'s Cache Storage API? This will force the application to redownload all assets on the next reload.',
    confirmButtonText: 'Clear All',
    confirmButtonVariant: 'danger',
  });
  if (confirmed) {
    if (window.caches) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  }
}

function handleReload() {
  window.location.reload();
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div data-testid="developer-section" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-8">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <Cpu class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Developer Tools</h2>
      </div>

      <div class="space-y-8">
        <div class="space-y-4">
          <h3 class="text-sm font-bold text-gray-500 uppercase tracking-widest ml-1">Experimental Features</h3>
          <FeatureFlagsSettings />
        </div>

        <div class="space-y-4">
          <h3 class="text-sm font-bold text-gray-500 uppercase tracking-widest ml-1">Debug & Testing</h3>
          <div class="flex flex-col sm:flex-row gap-4">
            <button
              @click="createSampleChat"
              class="flex-1 flex items-center justify-center gap-3 px-6 py-4 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-2xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95"
              data-testid="setting-create-sample-button"
            >
              <FlaskConical class="w-5 h-5" />
              Create Sample Chat
            </button>
          </div>
          <p class="text-[11px] font-medium text-gray-400 ml-1">Adds a sample conversation with complex structures to verify rendering.</p>
        </div>

        <div class="space-y-4">
          <button
            @click="togglePWAUpdate"
            class="w-full flex items-center justify-between px-6 py-4 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-2xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95 text-left"
            :class="{ 'ring-2 ring-emerald-500/20 border-emerald-500/50 bg-emerald-50/30 dark:bg-emerald-900/10': needRefresh }"
            data-testid="toggle-pwa-update-button"
          >
            <div class="flex items-center gap-3">
              <div class="p-2 bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
                <RefreshCw class="w-4 h-4" :class="needRefresh ? 'text-emerald-500 animate-spin-slow' : 'text-gray-400'" />
              </div>
              <div class="flex flex-col">
                <span class="text-sm font-bold">Simulate PWA Update</span>
                <span class="text-[10px] font-medium text-gray-500">Toggle update notification for testing</span>
              </div>
            </div>
            <div v-if="needRefresh" class="flex h-2 w-2 relative">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </div>
          </button>
        </div>

        <div class="space-y-4">
          <button
            @click="handleClearAllCacheStorage"
            class="w-full flex items-center justify-between px-6 py-4 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-2xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95 text-left"
            data-testid="clear-all-cache-storage-button"
          >
            <div class="flex items-center gap-3">
              <div class="p-2 bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
                <Trash2 class="w-4 h-4 text-gray-400" />
              </div>
              <div class="flex flex-col">
                <span class="text-sm font-bold">Clear All Cache Storage</span>
                <span class="text-[10px] font-medium text-gray-500">Deletes all entries in the browser's Cache Storage API</span>
              </div>
            </div>
          </button>
        </div>

        <div class="space-y-4">
          <button
            @click="handleReload"
            class="w-full flex items-center justify-between px-6 py-4 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-700 dark:text-gray-300 rounded-2xl text-sm font-bold hover:bg-gray-100 dark:hover:bg-gray-700 transition-all shadow-sm active:scale-95 text-left"
            data-testid="reload-app-button"
          >
            <div class="flex items-center gap-3">
              <div class="p-2 bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
                <RefreshCw class="w-4 h-4 text-gray-400" />
              </div>
              <div class="flex flex-col">
                <span class="text-sm font-bold">Reload Application</span>
                <span class="text-[10px] font-medium text-gray-500">Perform a simple window reload</span>
              </div>
            </div>
          </button>
        </div>

        <div class="pt-8 border-t border-gray-100 dark:border-gray-800 space-y-5">
          <h3 class="text-sm font-bold text-red-500 uppercase tracking-widest ml-1">Danger Zone</h3>
          <div class="p-6 border border-red-100 dark:border-red-900/20 bg-red-50/30 dark:bg-red-900/5 rounded-3xl space-y-6">
            <div class="flex items-start gap-4">
              <div class="p-2 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-red-100 dark:border-red-900/20">
                <AlertTriangle class="w-6 h-6 text-red-500 shrink-0" />
              </div>
              <div>
                <h4 class="font-bold text-red-800 dark:text-red-400 text-sm">Reset All Application Data</h4>
                <p class="text-xs font-medium text-red-600/70 dark:text-red-400/60 mt-1.5 leading-relaxed">
                  This action cannot be undone. It will permanently delete all chat history, chat groups, and settings stored in the <strong>{{ storageType }}</strong> provider.
                </p>
              </div>
            </div>
            <button
              @click="handleResetData"
              class="w-full flex items-center justify-center gap-2 px-6 py-4 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-sm font-bold transition-all shadow-lg shadow-red-500/20 active:scale-95"
              data-testid="setting-reset-data-button"
            >
              <Trash2 class="w-4 h-4" />
              Execute Reset
            </button>
          </div>
        </div>
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
