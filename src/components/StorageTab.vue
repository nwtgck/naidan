<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { storageService } from '@/services/storage';
import { checkOPFSSupport } from '@/services/storage/opfs-detection';
import { computedAsync } from '@vueuse/core';
import {
  ShieldCheckIcon, CheckCircle2Icon, FileArchiveIcon,
  DatabaseIcon, HardDriveIcon, InfoIcon, Trash2Icon, GhostIcon,
  LinkIcon, Loader2Icon,
} from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { urlImportExportLogic } from '@/services/import-export/url-logic';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { useExportExclusions } from '@/composables/useExportExclusions';
import { lazyStrings, ensureStrings } from '@/strings';

// Lazily load the import/export modal as it is a heavy secondary action, but prefetch it when idle.
const ImportExportModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ImportExportModal.vue') });

const props = defineProps<{
  storageType: 'local' | 'opfs' | 'memory',
}>();

const emit = defineEmits<{
  (e: 'update:storageType', value: 'local' | 'opfs' | 'memory'): void,
  (e: 'close'): void,
}>();

const { save } = useSettings();
const chatLifecycle = useChatLifecycle();
const { showConfirm } = useConfirm();
const { addToast } = useToast();
const router = useRouter();

const isOPFSSupported = computedAsync(async () => {
  return await checkOPFSSupport();
}, false);

const showImportExportModal = ref(false);
const isExportingURL = ref(false);

const {
  excludeChats,
  excludeChatHistory,
  excludeAttachments,
  excludeChatHistoryDisabled,
  buildExcludeList,
} = useExportExclusions();

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
    const [title, message, confirmButtonText] = await Promise.all([
      ensureStrings.StorageTab__not_supported(),
      ensureStrings.StorageTab__persistent_storage_not_supported(),
      ensureStrings.StorageTab__understand(),
    ]);
    await showConfirm({ title, message, confirmButtonText });
    return;
  }

  try {
    const persistent = await navigator.storage.persist();
    storagePersistenceStatus.value = persistent ? 'persisted' : 'not-persisted';
    if (!persistent) {
      const [title, message, confirmButtonText] = await Promise.all([
        ensureStrings.StorageTab__persistence_denied(),
        ensureStrings.StorageTab__browser_declined_persistence(),
        ensureStrings.StorageTab__understand(),
      ]);
      await showConfirm({ title, message, confirmButtonText });
    }
  } catch (err) {
    console.error('Failed to enable persistence:', err);
    const [title, message, confirmButtonText] = await Promise.all([
      ensureStrings.StorageTab__error(),
      ensureStrings.StorageTab__failed_to_enable_persistence({ errorMessage: err instanceof Error ? err.message : String(err) }),
      ensureStrings.StorageTab__understand(),
    ]);
    await showConfirm({ title, message, confirmButtonText });
  }
}

async function handleStorageChange({ targetType }: { targetType: 'local' | 'opfs' | 'memory' }) {
  if (targetType === props.storageType) return;

  const currentProviderType = storageService.getCurrentType();

  // Check for potential data loss when switching FROM opfs/memory TO local
  if ((currentProviderType === 'opfs' || currentProviderType === 'memory') && targetType === 'local') {
    const hasFiles = await storageService.hasAttachments();
    if (hasFiles) {
      const [title, message, confirmButtonText] = await Promise.all([
        ensureStrings.StorageTab__attachments_will_be_inaccessible(),
        ensureStrings.StorageTab__local_storage_loses_attachments(),
        ensureStrings.StorageTab__switch_and_lose_attachments(),
      ]);
      const confirmed = await showConfirm({ title, message, confirmButtonText, confirmButtonVariant: 'danger' });
      if (!confirmed) {
        return;
      }
    }
  }

  const storageName = await (() => {
    switch (targetType) {
    case 'opfs': return ensureStrings.StorageTab__origin_private_file_system();
    case 'local': return ensureStrings.StorageTab__local_storage();
    case 'memory': return ensureStrings.StorageTab__ephemeral();
    default: {
      const _ex: never = targetType;
      return _ex;
    }
    }
  })();
  const [title, message, confirmButtonText] = await Promise.all([
    ensureStrings.StorageTab__confirm_storage_switch(),
    ensureStrings.StorageTab__confirm_switch_to_storage({ storageName }),
    ensureStrings.StorageTab__switch_and_migrate(),
  ]);
  const confirmed = await showConfirm({ title, message, confirmButtonText });

  if (!confirmed) {
    return;
  }

  try {
    // Only pass storageType to save as a patch
    await save({ patch: { storageType: targetType } });
    emit('update:storageType', targetType);
  } catch (err) {
    console.error('Failed to migrate storage:', err);
    const [title, message, confirmButtonText] = await Promise.all([
      ensureStrings.StorageTab__migration_failed(),
      ensureStrings.StorageTab__failed_to_migrate_data({ errorMessage: err instanceof Error ? err.message : String(err) }),
      ensureStrings.StorageTab__understand(),
    ]);
    await showConfirm({ title, message, confirmButtonText });
  }
}

async function handleDeleteAllHistory() {
  const [title, message, confirmButtonText] = await Promise.all([
    ensureStrings.StorageTab__clear_history(),
    ensureStrings.StorageTab__delete_all_chats_warning(),
    ensureStrings.StorageTab__clear_all(),
  ]);
  const confirmed = await showConfirm({ title, message, confirmButtonText, confirmButtonVariant: 'danger' });

  if (confirmed) {
    await chatLifecycle.deleteAllChats();
    emit('close');
    router.push('/');
  }
}

async function handleCopyExportURL() {
  if (isExportingURL.value) return;

  isExportingURL.value = true;
  try {
    const url = await urlImportExportLogic.getExportURL({
      exclude: buildExcludeList(),
      baseUrl: window.location.href,
    });
    await navigator.clipboard.writeText(url);
    addToast({ message: await ensureStrings.StorageTab__export_url_copied(), duration: 3000 });
  } catch (err) {
    console.error('Failed to copy export URL:', err);
    addToast({
      message: await ensureStrings.StorageTab__failed_to_generate_export_url({ errorMessage: err instanceof Error ? err.message : String(err) }),
      duration: 5000,
    });
  } finally {
    isExportingURL.value = false;
  }
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div data-testid="storage-section" class="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <ShieldCheckIcon class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.StorageTab__data_durability() }}</h2>
      </div>

      <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 flex items-center justify-between gap-6 shadow-sm">
        <div class="space-y-1">
          <h4 class="font-bold text-gray-800 dark:text-white text-sm flex items-center gap-2">
            {{ lazyStrings.StorageTab__persistent_storage() }}
            <span v-if="storagePersistenceStatus === 'persisted'" class="text-[9px] px-1.5 py-0.5 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg font-bold uppercase tracking-wider border border-green-100 dark:border-green-900/30">{{ lazyStrings.StorageTab__active() }}</span>
            <span v-else-if="storagePersistenceStatus === 'not-persisted'" class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">{{ lazyStrings.StorageTab__best_effort() }}</span>
            <span v-else class="text-[9px] px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 text-gray-400 rounded-lg font-bold uppercase tracking-wider border border-gray-100 dark:border-gray-700">{{ lazyStrings.StorageTab__checking() }}</span>
          </h4>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.StorageTab__persistent_storage_description() }}
          </p>
        </div>
        <button
          v-if="storagePersistenceStatus !== 'persisted'"
          @click="handleEnablePersistence"
          class="shrink-0 flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-500/20 active:scale-95"
          data-testid="setting-enable-persistence-button"
        >
          <ShieldCheckIcon class="w-4 h-4" />
          {{ lazyStrings.StorageTab__enable() }}
        </button>
        <div v-else class="flex items-center gap-2 px-4 py-2 text-green-600 dark:text-green-400 text-xs font-bold">
          <CheckCircle2Icon class="w-4 h-4" />
          {{ lazyStrings.StorageTab__protected() }}
        </div>
      </div>
    </section>

    <section class="space-y-6">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <FileArchiveIcon class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.StorageTab__backup_and_restore() }}</h2>
      </div>

      <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 flex items-center justify-between gap-6 shadow-sm">
        <div class="space-y-1">
          <h4 class="font-bold text-gray-800 dark:text-white text-sm flex items-center gap-2">
            {{ lazyStrings.StorageTab__export_import() }}
            <span class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">{{ lazyStrings.StorageTab__experimental() }}</span>
          </h4>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.StorageTab__backup_restore_description() }}
          </p>
        </div>
        <button
          @click="showImportExportModal = true"
          class="shrink-0 flex items-center gap-2 px-6 py-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-xs font-bold transition-all shadow-sm active:scale-95"
          data-testid="setting-import-export-button"
        >
          <FileArchiveIcon class="w-4 h-4" />
          {{ lazyStrings.StorageTab__manage_data() }}
        </button>
      </div>

      <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 flex items-center justify-between gap-6 shadow-sm">
        <div class="space-y-1">
          <h4 class="font-bold text-gray-800 dark:text-white text-sm flex items-center gap-2">
            {{ lazyStrings.StorageTab__share_via_url() }}
          </h4>
          <p class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.StorageTab__share_url_description() }}
            <span class="block mt-1 text-gray-400 dark:text-gray-500 italic">{{ lazyStrings.StorageTab__large_storage_link_warning() }}</span>
          </p>

          <div class="mt-4 flex flex-wrap gap-4">
            <label class="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                v-model="excludeChats"
                data-testid="setting-exclude-chats-checkbox"
                class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
              />
              <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.StorageTab__exclude_chats() }}</span>
            </label>
            <label
              class="flex items-center gap-2 group"
              :class="excludeChatHistoryDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
            >
              <input
                type="checkbox"
                v-model="excludeChatHistory"
                :disabled="excludeChatHistoryDisabled"
                data-testid="setting-exclude-chat-history-checkbox"
                class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700 disabled:cursor-not-allowed"
              />
              <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.StorageTab__exclude_chat_history() }}</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                v-model="excludeAttachments"
                data-testid="setting-exclude-attachments-checkbox"
                class="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 dark:bg-gray-700"
              />
              <span class="text-xs font-bold text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.StorageTab__exclude_attachments() }}</span>
            </label>
          </div>
        </div>
        <button
          @click="handleCopyExportURL"
          :disabled="isExportingURL"
          class="shrink-0 flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-blue-500/20 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="setting-copy-export-url-button"
        >
          <Loader2Icon v-if="isExportingURL" class="w-4 h-4 animate-spin" />
          <LinkIcon v-else class="w-4 h-4" />
          <span v-if="isExportingURL">{{ lazyStrings.StorageTab__generating() }}</span>
          <span v-else>{{ lazyStrings.StorageTab__copy_link() }}</span>
        </button>
      </div>
    </section>

    <section class="space-y-6 pt-8 border-t border-gray-100 dark:border-gray-800">
      <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
        <DatabaseIcon class="w-5 h-5 text-blue-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.StorageTab__storage_management() }}</h2>
      </div>

      <div class="space-y-6">
        <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.StorageTab__active_storage_provider() }}</label>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <button
            @click="handleStorageChange({ targetType: 'opfs' })"
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
                <HardDriveIcon class="w-4 h-4 text-gray-600 dark:text-gray-300" />
              </div>
              <span v-if="isOPFSSupported" class="text-[10px] bg-green-50 dark:bg-green-900/20 text-green-600/80 dark:text-green-500/80 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">{{ lazyStrings.StorageTab__recommended() }}</span>
              <span v-else class="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600/80 dark:text-red-500/80 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">{{ lazyStrings.StorageTab__unsupported() }}</span>
            </div>
            <div>
              <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">{{ lazyStrings.StorageTab__origin_private_file_system() }}</div>
              <div class="text-xs font-medium text-gray-500 leading-relaxed">{{ lazyStrings.StorageTab__opfs_description() }}</div>
            </div>
          </button>
          <button
            @click="handleStorageChange({ targetType: 'local' })"
            type="button"
            class="text-left border-2 rounded-2xl p-6 transition-all shadow-sm flex flex-col gap-3"
            :class="storageType === 'local' ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20' : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-gray-200 dark:hover:border-gray-700'"
            data-testid="storage-local"
          >
            <div class="flex items-center justify-between">
              <div class="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                <HardDriveIcon class="w-4 h-4 text-gray-600 dark:text-gray-300" />
              </div>
            </div>
            <div>
              <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">{{ lazyStrings.StorageTab__local_storage() }}</div>
              <div class="text-xs font-medium text-gray-500 leading-relaxed">{{ lazyStrings.StorageTab__local_storage_description() }}</div>
            </div>
          </button>
          <button
            @click="handleStorageChange({ targetType: 'memory' })"
            type="button"
            class="text-left border-2 rounded-2xl p-6 transition-all shadow-sm flex flex-col gap-3"
            :class="storageType === 'memory' ? 'border-purple-500 bg-purple-50/50 dark:bg-purple-900/20' : 'border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-800 hover:border-gray-200 dark:hover:border-gray-700'"
            data-testid="storage-memory"
          >
            <div class="flex items-center justify-between">
              <div class="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                <GhostIcon class="w-4 h-4 text-gray-600 dark:text-gray-300" />
              </div>
            </div>
            <div>
              <div class="font-bold text-base mb-1 text-gray-800 dark:text-white">{{ lazyStrings.StorageTab__ephemeral() }}</div>
              <div class="text-xs font-medium text-gray-500 leading-relaxed">{{ lazyStrings.StorageTab__ephemeral_description() }}</div>
            </div>
          </button>
        </div>

        <div class="flex items-start gap-4 p-5 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700 dark:text-blue-300 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/30">
          <InfoIcon class="w-5 h-5 shrink-0 mt-0.5 text-blue-500" />
          <p class="leading-relaxed">{{ lazyStrings.StorageTab__storage_migration_description() }}</p>
        </div>
      </div>
    </section>

    <section class="space-y-6 pt-8 border-t border-gray-100 dark:border-gray-800">
      <div class="flex items-center gap-2 pb-3">
        <Trash2Icon class="w-5 h-5 text-red-500" />
        <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.StorageTab__data_cleanup() }}</h2>
      </div>

      <div class="p-6 border border-red-100 dark:border-red-900/20 bg-red-50/30 dark:bg-red-900/5 rounded-3xl space-y-4">
        <div>
          <h4 class="font-bold text-red-800 dark:text-red-400 text-sm">{{ lazyStrings.StorageTab__clear_conversation_history() }}</h4>
          <p class="text-xs font-medium text-red-600/70 dark:text-red-400/60 mt-1.5 leading-relaxed">
            {{ lazyStrings.StorageTab__clear_history_description() }}
          </p>
        </div>
        <button
          @click="handleDeleteAllHistory"
          class="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-sm font-bold transition-all shadow-lg shadow-red-500/20 active:scale-95"
          data-testid="setting-clear-history-button"
        >
          <Trash2Icon class="w-4 h-4" />
          {{ lazyStrings.StorageTab__clear_all_conversation_history() }}
        </button>
      </div>
    </section>

    <ImportExportModal
      :is-open="showImportExportModal"
      @close="showImportExportModal = false"
    />
  </div>
</template>
