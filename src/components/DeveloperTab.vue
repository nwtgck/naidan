<script setup lang="ts">
import { useSampleChat } from '../composables/useSampleChat';
import { useConfirm } from '../composables/useConfirm';
import { storageService } from '../services/storage';
import { Cpu, FlaskConical, AlertTriangle, Trash2 } from 'lucide-vue-next';

defineProps<{
  storageType: string;
}>();

const { createSampleChat } = useSampleChat();
const { showConfirm } = useConfirm();

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
