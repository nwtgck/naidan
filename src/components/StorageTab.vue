<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { storageService } from '../services/storage';
import { checkOPFSSupport } from '../services/storage/opfs-detection';
import { computedAsync } from '@vueuse/core';
import { 
  ShieldCheck, CheckCircle2, FileArchive, 
  Database, HardDrive, Info, Trash2
} from 'lucide-vue-next';
import { useConfirm } from '../composables/useConfirm';
import ImportExportModal from './ImportExportModal.vue';

const props = defineProps<{
  storageType: 'local' | 'opfs';
}>();

const emit = defineEmits<{
  (e: 'update:storageType', value: 'local' | 'opfs'): void;
  (e: 'close'): void;
}>();

const { save } = useSettings();
const chatStore = useChat();
const { showConfirm } = useConfirm();
const router = useRouter();

const isOPFSSupported = computedAsync(async () => {
  return await checkOPFSSupport();
}, false);

const showImportExportModal = ref(false);

// Persistence State
type PersistenceStatus = 'unknown' | 'persisted' | 'not-persisted';
const storagePersistenceStatus = ref<PersistenceStatus>('unknown');

async function checkPersistenceStatus() {
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
    const isPersisted = await navigator.storage.persisted();
    storagePersistenceStatus.value = isPersisted ? 'persisted' : 'not-persisted';
  }
}

onMounted(() => {
  checkPersistenceStatus();
});

async function handleEnablePersistence() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) {
    await showConfirm({
      title: 'Not Supported',
      message: 'Persistent storage is not supported by your browser.',
      confirmButtonText: 'Understand',
    });
    return;
  }

  try {
    const persistent = await navigator.storage.persist();
    storagePersistenceStatus.value = persistent ? 'persisted' : 'not-persisted';
    if (!persistent) {
      await showConfirm({
        title: 'Persistence Denied',
        message: 'The browser declined the request for persistent storage. This can happen if the site has not been used enough or if the browser settings prevent it.',
        confirmButtonText: 'Understand',
      });
    }
  } catch (err) {
    console.error('Failed to enable persistence:', err);
    await showConfirm({
      title: 'Error',
      message: `An error occurred while enabling persistent storage: ${err instanceof Error ? err.message : String(err)}`,
      confirmButtonText: 'Understand',
    });
  }
}

async function handleStorageChange(targetType: 'local' | 'opfs') {
  if (targetType === props.storageType) return;

  const currentProviderType = storageService.getCurrentType();
  
  // Check for potential data loss when switching FROM opfs TO local
  if (currentProviderType === 'opfs' && targetType === 'local') {
    const hasFiles = await storageService.hasAttachments();
    if (hasFiles) {
      const confirmed = await showConfirm({
        title: 'Attachments will be inaccessible',
        message: 'You have images or files saved in OPFS. Local Storage does not support permanent file storage, so these attachments will not be accessible after switching. Are you sure you want to continue?',
        confirmButtonText: 'Switch and Lose Attachments',
        confirmButtonVariant: 'danger',
      });
      if (!confirmed) {
        return;
      }
    }
  }

  const confirmed = await showConfirm({
    title: 'Confirm Storage Switch',
    message: `Are you sure you want to switch to ${(() => {
      switch (targetType) {
      case 'opfs': return 'OPFS';
      case 'local': return 'Local Storage';
      default: {
        const _ex: never = targetType;
        return _ex;
      }
      }
    })()}? This will migrate all your data and the application will reload.`,
    confirmButtonText: 'Switch and Migrate',
  });

  if (!confirmed) {
    return;
  }

  try {
    // Only pass storageType to save as a patch
    await save({ storageType: targetType });
    emit('update:storageType', targetType);
  } catch (err) {
    console.error('Failed to migrate storage:', err);
    await showConfirm({
      title: 'Migration Failed',
      message: `Failed to migrate data. ${err instanceof Error ? err.message : String(err)}`,
      confirmButtonText: 'Understand',
    });
  }
}

async function handleDeleteAllHistory() {
  const confirmed = await showConfirm({
    title: 'Clear History',
    message: 'Are you absolutely sure you want to delete ALL chats and chat groups? This action cannot be undone.',
    confirmButtonText: 'Clear All',
    confirmButtonVariant: 'danger',
  });

  if (confirmed) {
    await chatStore.deleteAllChats();
    emit('close');
    router.push('/');
  }
}
</script>

<template>
  <div data-testid="storage-section" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <ShieldCheck class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Data Durability</h2>
      </div>
    
      <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 flex items-center justify-between gap-6 shadow-sm">
        <div class="space-y-1">
          <h4 class="font-bold text-gray-800 dark:text-white text-sm flex items-center gap-2">
            Persistent Storage
            <span v-if="storagePersistenceStatus === 'persisted'" class="text-[9px] px-1.5 py-0.5 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg font-bold uppercase tracking-wider border border-green-100 dark:border-green-900/30">Active</span>
            <span v-else-if="storagePersistenceStatus === 'not-persisted'" class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">Best Effort</span>
            <span v-else class="text-[9px] px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 text-gray-400 rounded-lg font-bold uppercase tracking-wider border border-gray-100 dark:border-gray-700">Checking...</span>
          </h4>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            Enable persistent storage to prevent the browser from automatically deleting your chat history and settings during storage pressure.
          </p>
        </div>
        <button 
          v-if="storagePersistenceStatus !== 'persisted'"
          @click="handleEnablePersistence"
          class="shrink-0 flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-500/20 active:scale-95"
          data-testid="setting-enable-persistence-button"
        >
          <ShieldCheck class="w-4 h-4" />
          Enable
        </button>
        <div v-else class="flex items-center gap-2 px-4 py-2 text-green-600 dark:text-green-400 text-xs font-bold">
          <CheckCircle2 class="w-4 h-4" />
          Protected
        </div>
      </div>
    </section>

    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <FileArchive class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Backup & Restore</h2>
      </div>
    
      <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 flex items-center justify-between gap-6 shadow-sm">
        <div class="space-y-1">
          <h4 class="font-bold text-gray-800 dark:text-white text-sm flex items-center gap-2">
            Export / Import
            <span class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">Experimental</span>
          </h4>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            Backup your entire chat history and settings to a ZIP file, or restore from a previous export.
          </p>
        </div>
        <button 
          @click="showImportExportModal = true"
          class="shrink-0 flex items-center gap-2 px-6 py-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-xs font-bold transition-all shadow-sm active:scale-95"
          data-testid="setting-import-export-button"
        >
          <FileArchive class="w-4 h-4" />
          Manage Data
        </button>
      </div>
    </section>

    <section class="space-y-6 pt-8 border-t border-gray-100 dark:border-gray-800">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <Database class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Storage Management</h2>
      </div>
    
      <div class="space-y-6">
        <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">Active Storage Provider</label>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <button 
            @click="handleStorageChange('opfs')"
            type="button"
            :disabled="!isOPFSSupported"
            class="text-left border-2 rounded-2xl p-6 transition-all shadow-sm flex flex-col gap-3"
            :class="[
              storageType === 'opfs' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-gray-200 dark:hover:border-gray-700',
              !isOPFSSupported ? 'opacity-50 cursor-not-allowed grayscale' : ''
            ]"
            data-testid="storage-opfs"
          >
            <div class="flex items-center justify-between">
              <div class="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                <HardDrive class="w-4 h-4 text-gray-600 dark:text-gray-300" />
              </div>
              <span v-if="isOPFSSupported" class="text-[10px] bg-green-50 dark:bg-green-900/20 text-green-600/80 dark:text-green-500/80 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">Recommended</span>
              <span v-else class="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600/80 dark:text-red-500/80 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">Unsupported</span>
            </div>
            <div>
              <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">Origin Private File System (OPFS)</div>
              <div class="text-xs font-medium text-gray-500 leading-relaxed">Save locally in the browser's high-capacity file system. Optimized for large data and attachments.</div>
            </div>
          </button>
          <button 
            @click="handleStorageChange('local')"
            type="button"
            class="text-left border-2 rounded-2xl p-6 transition-all shadow-sm flex flex-col gap-3"
            :class="storageType === 'local' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-gray-200 dark:hover:border-gray-700'"
            data-testid="storage-local"
          >
            <div class="flex items-center justify-between">
              <div class="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                <HardDrive class="w-4 h-4 text-gray-600 dark:text-gray-300" />
              </div>
            </div>
            <div>
              <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">Local Storage</div>
              <div class="text-xs font-medium text-gray-500 leading-relaxed">Save locally in the standard browser storage. Limited size (5-10MB). Sent images are NOT persisted.</div>
            </div>
          </button>
        </div>
      
        <div class="flex items-start gap-4 p-5 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-300 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/30">
          <Info class="w-5 h-5 shrink-0 mt-0.5 text-blue-500" />
          <p class="leading-relaxed">Switching storage will <strong>migrate</strong> all your chats, chat groups, and settings to the new location. This process will start automatically after you confirm the switch.</p>
        </div>
      </div>
    </section>

    <section class="space-y-6 pt-8 border-t border-gray-100 dark:border-gray-800">
      <div class="flex items-center gap-2 pb-3">
        <Trash2 class="w-5 h-5 text-red-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Data Cleanup</h2>
      </div>
    
      <div class="p-6 border border-red-100 dark:border-red-900/20 bg-red-50/30 dark:bg-red-900/5 rounded-3xl space-y-4">
        <div>
          <h4 class="font-bold text-red-800 dark:text-red-400 text-sm">Clear Conversation History</h4>
          <p class="text-xs font-medium text-red-600/70 dark:text-red-400/60 mt-1.5 leading-relaxed">
            This will permanently delete all your chats and chat groups. Your settings and provider profiles will be preserved.
          </p>
        </div>
        <button 
          @click="handleDeleteAllHistory"
          class="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-sm font-bold transition-all shadow-lg shadow-red-500/20 active:scale-95"
          data-testid="setting-clear-history-button"
        >
          <Trash2 class="w-4 h-4" />
          Clear All Conversation History
        </button>
      </div>
    </section>

    <ImportExportModal 
      :is-open="showImportExportModal" 
      @close="showImportExportModal = false" 
    />
  </div>
</template>
