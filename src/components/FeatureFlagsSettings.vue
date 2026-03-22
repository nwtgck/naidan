<script setup lang="ts">
import { FlaskConical, Folder, Terminal, AlertTriangle } from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { useFeatureFlags } from '@/composables/useFeatureFlags';

const { isFeatureEnabled, setFeatureEnabled } = useFeatureFlags();
const { showConfirm } = useConfirm();

async function handleFeatureToggle({ feature }: { feature: 'volume' | 'wesh_tool' }) {
  if (isFeatureEnabled({ feature })) {
    setFeatureEnabled({
      feature,
      enabled: false,
    });
    return;
  }

  const confirmed = await showConfirm({
    title: 'Enable Experimental Feature?',
    message: 'This feature is experimental. Future updates may include breaking changes or remove compatibility with the data and behavior introduced by this flag.',
    confirmButtonText: 'Enable',
    cancelButtonText: 'Cancel',
  });

  if (!confirmed) {
    return;
  }

  setFeatureEnabled({
    feature,
    enabled: true,
  });
}

defineExpose({
  __testOnly: {
    handleFeatureToggle,
  }
});
</script>

<template>
  <div class="space-y-4" data-testid="feature-flags-settings">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div
        class="rounded-3xl border p-5 shadow-sm transition-all"
        :class="isFeatureEnabled({ feature: 'volume' }) ? 'border-red-200/80 dark:border-red-900/30 bg-red-50/60 dark:bg-red-950/10' : 'border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40'"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-3 min-w-0">
            <div class="p-2 bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
              <Folder class="w-4 h-4" :class="isFeatureEnabled({ feature: 'volume' }) ? 'text-red-500' : 'text-gray-400'" />
            </div>
            <div class="flex flex-col min-w-0">
              <span class="text-sm font-bold text-gray-900 dark:text-gray-100">Folders</span>
              <span class="text-[10px] font-medium text-gray-500">Shows the Folders tab in Settings.</span>
            </div>
          </div>
          <div
            class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
            :class="isFeatureEnabled({ feature: 'volume' }) ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300'"
          >
            <AlertTriangle v-if="isFeatureEnabled({ feature: 'volume' })" class="w-3 h-3" />
            {{ isFeatureEnabled({ feature: 'volume' }) ? 'Enabled' : 'Disabled' }}
          </div>
        </div>

        <div class="mt-4 flex items-center justify-between gap-4">
          <p class="text-[11px] font-medium leading-relaxed" :class="isFeatureEnabled({ feature: 'volume' }) ? 'text-red-800/80 dark:text-red-200/80' : 'text-gray-600 dark:text-gray-300'">
            {{ isFeatureEnabled({ feature: 'volume' }) ? 'Experimental feature is active for this browser profile. Future updates may break compatibility.' : 'Hidden by default. Enable only if you want to try the experimental feature.' }}
          </p>
          <button
            @click="handleFeatureToggle({ feature: 'volume' })"
            class="shrink-0 rounded-2xl px-4 py-2 text-xs font-bold transition-all active:scale-95"
            :class="isFeatureEnabled({ feature: 'volume' }) ? 'bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-500/20 ring-2 ring-red-500/20' : 'bg-gray-900 hover:bg-black text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white'"
            data-testid="feature-flag-volume-toggle"
          >
            {{ isFeatureEnabled({ feature: 'volume' }) ? 'Disable experimental feature' : 'Enable' }}
          </button>
        </div>
      </div>

      <div
        class="rounded-3xl border p-5 shadow-sm transition-all"
        :class="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'border-red-200/80 dark:border-red-900/30 bg-red-50/60 dark:bg-red-950/10' : 'border-gray-200/80 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/40'"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-3 min-w-0">
            <div class="p-2 bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
              <Terminal class="w-4 h-4" :class="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'text-red-500' : 'text-gray-400'" />
            </div>
            <div class="flex flex-col min-w-0">
              <span class="text-sm font-bold text-gray-900 dark:text-gray-100">Shell in browser</span>
              <span class="text-[10px] font-medium text-gray-500">Shows Shell in browser in the chat tools menu.</span>
            </div>
          </div>
          <div
            class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
            :class="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300'"
          >
            <AlertTriangle v-if="isFeatureEnabled({ feature: 'wesh_tool' })" class="w-3 h-3" />
            {{ isFeatureEnabled({ feature: 'wesh_tool' }) ? 'Enabled' : 'Disabled' }}
          </div>
        </div>

        <div class="mt-4 flex items-center justify-between gap-4">
          <p class="text-[11px] font-medium leading-relaxed" :class="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'text-red-800/80 dark:text-red-200/80' : 'text-gray-600 dark:text-gray-300'">
            {{ isFeatureEnabled({ feature: 'wesh_tool' }) ? 'Experimental feature is active for this browser profile. Future updates may break compatibility.' : 'Hidden by default. Enable only if you want to try the experimental feature.' }}
          </p>
          <button
            @click="handleFeatureToggle({ feature: 'wesh_tool' })"
            class="shrink-0 rounded-2xl px-4 py-2 text-xs font-bold transition-all active:scale-95"
            :class="isFeatureEnabled({ feature: 'wesh_tool' }) ? 'bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-500/20 ring-2 ring-red-500/20' : 'bg-gray-900 hover:bg-black text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white'"
            data-testid="feature-flag-wesh-tool-toggle"
          >
            {{ isFeatureEnabled({ feature: 'wesh_tool' }) ? 'Disable experimental feature' : 'Enable' }}
          </button>
        </div>
      </div>
    </div>

    <div class="rounded-2xl border border-amber-200/70 dark:border-amber-900/30 bg-amber-50/60 dark:bg-amber-950/10 px-4 py-3">
      <div class="flex items-start gap-3">
        <FlaskConical class="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <p class="text-[11px] font-medium text-amber-800/80 dark:text-amber-200/80 leading-relaxed">
          Enabling an experimental feature requires acknowledging that future updates may break compatibility or remove the feature entirely.
        </p>
      </div>
    </div>
  </div>
</template>
