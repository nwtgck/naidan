<script setup lang="ts">
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { storageService } from '@/00-storage/service';
import { checkOPFSSupport } from '@/utils/opfs-detection';
import { computedAsync } from '@vueuse/core';
import {
  ShieldCheckIcon, CheckCircle2Icon, FileArchiveIcon,
  DatabaseIcon, HardDriveIcon, InfoIcon, Trash2Icon, GhostIcon,
  LinkIcon, Loader2Icon,
} from 'lucide-vue-next';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';
import { urlImportExportLogic } from '@/features/import-export/url-logic';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { useExportExclusions } from '@/features/import-export/composables/useExportExclusions';
import { lazyStrings, ensureStrings } from '@/strings';

// Lazily load the import/export modal as it is a heavy secondary action, but prefetch it when idle.
const ImportExportModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/import-export/components/ImportExportModal.vue') });

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
    await showConfirm({
      title: await ensureStrings.StorageTab__not_supported(),
      message: await ensureStrings.StorageTab__persistent_storage_not_supported(),
      confirmButtonText: await ensureStrings.StorageTab__understand(),
    });
    return;
  }

  try {
    const persistent = await navigator.storage.persist();
    storagePersistenceStatus.value = persistent ? 'persisted' : 'not-persisted';
    if (!persistent) {
      await showConfirm({
        title: await ensureStrings.StorageTab__persistence_denied(),
        message: await ensureStrings.StorageTab__browser_declined_persistence(),
        confirmButtonText: await ensureStrings.StorageTab__understand(),
      });
    }
  } catch (err) {
    console.error('Failed to enable persistence:', err);
    await showConfirm({
      title: await ensureStrings.StorageTab__error(),
      message: await ensureStrings.StorageTab__failed_to_enable_persistence({ errorMessage: err instanceof Error ? err.message : String(err) }),
      confirmButtonText: await ensureStrings.StorageTab__understand(),
    });
  }
}

async function handleStorageChange({ targetType }: { targetType: 'local' | 'opfs' | 'memory' }) {
  if (targetType === props.storageType) {
    return;
  }

  const currentProviderType = storageService.getCurrentType();

  // Check for potential data loss when switching FROM opfs/memory TO local
  if ((currentProviderType === 'opfs' || currentProviderType === 'memory') && targetType === 'local') {
    const hasFiles = await storageService.hasAttachments();
    if (hasFiles) {
      const confirmed = await showConfirm({
        title: await ensureStrings.StorageTab__attachments_will_be_inaccessible(),
        message: await ensureStrings.StorageTab__local_storage_loses_attachments(),
        confirmButtonText: await ensureStrings.StorageTab__switch_and_lose_attachments(),
        confirmButtonVariant: 'danger',
      });
      if (!confirmed) {
        return;
      }
    }
  }

  let storageName: string;
  switch (targetType) {
  case 'opfs':
    storageName = await ensureStrings.StorageTab__origin_private_file_system();
    break;
  case 'local':
    storageName = await ensureStrings.StorageTab__local_storage();
    break;
  case 'memory':
    storageName = await ensureStrings.StorageTab__ephemeral();
    break;
  default: {
    const _ex: never = targetType;
    throw new Error(`Unhandled storage type: ${_ex}`);
  }
  }
  const confirmed = await showConfirm({
    title: await ensureStrings.StorageTab__confirm_storage_switch(),
    message: await ensureStrings.StorageTab__confirm_switch_to_storage({ storageName }),
    confirmButtonText: await ensureStrings.StorageTab__switch_and_migrate(),
  });

  if (!confirmed) {
    return;
  }

  try {
    // Only pass storageType to save as a patch
    await save({
      patch: { storageType: targetType },
      modelRefresh: 'await',
    });
    emit('update:storageType', targetType);
  } catch (err) {
    console.error('Failed to migrate storage:', err);
    await showConfirm({
      title: await ensureStrings.StorageTab__migration_failed(),
      message: await ensureStrings.StorageTab__failed_to_migrate_data({ errorMessage: err instanceof Error ? err.message : String(err) }),
      confirmButtonText: await ensureStrings.StorageTab__understand(),
    });
  }
}

async function handleDeleteAllHistory() {
  const confirmed = await showConfirm({
    title: await ensureStrings.StorageTab__clear_history(),
    message: await ensureStrings.StorageTab__delete_all_chats_warning(),
    confirmButtonText: await ensureStrings.StorageTab__clear_all(),
    confirmButtonVariant: 'danger',
  });

  if (confirmed) {
    await chatLifecycle.deleteAllChats();
    emit('close');
    router.push('/');
  }
}

async function handleCopyExportURL() {
  if (isExportingURL.value) {
    return;
  }

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
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="storage-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-7 duration-300 motion-reduce:animate-none">
    <section tw-class="space-y-3">
      <div tw-class="flex items-center gap-3 pb-1">
        <span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><ShieldCheckIcon aria-hidden="true" tw-class="h-4 w-4" /></span>
        <h2 tw-class="text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__data_durability() }}</h2>
      </div>

      <div tw-class="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-800/80 dark:bg-gray-900/20">
        <div tw-class="min-w-0 flex-[1_1_15rem] space-y-1.5">
          <h4 tw-class="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {{ lazyStrings.StorageTab__persistent_storage() }}
            <span v-if="storagePersistenceStatus === 'persisted'" tw-class="text-[9px] px-1.5 py-0.5 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded-lg font-bold uppercase tracking-wider border border-green-100 dark:border-green-900/30">{{ lazyStrings.StorageTab__active() }}</span>
            <span v-else-if="storagePersistenceStatus === 'not-persisted'" tw-class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">{{ lazyStrings.StorageTab__best_effort() }}</span>
            <span v-else tw-class="text-[9px] px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 text-gray-400 rounded-lg font-bold uppercase tracking-wider border border-gray-100 dark:border-gray-700">{{ lazyStrings.StorageTab__checking() }}</span>
          </h4>
          <p tw-class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.StorageTab__persistent_storage_description() }}
          </p>
        </div>
        <button
          v-if="storagePersistenceStatus !== 'persisted'"
          @click="handleEnablePersistence"
          tw-class="group ml-auto inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-200 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/10"
          data-testid="setting-enable-persistence-button"
        >
          <ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
          {{ lazyStrings.StorageTab__enable() }}
        </button>
        <div v-else tw-class="flex items-center gap-2 px-4 py-2 text-green-600 dark:text-green-400 text-xs font-bold">
          <CheckCircle2Icon tw-class="w-4 h-4" />
          {{ lazyStrings.StorageTab__protected() }}
        </div>
      </div>
    </section>

    <section tw-class="space-y-3">
      <div tw-class="flex items-center gap-3 pb-1">
        <span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><FileArchiveIcon aria-hidden="true" tw-class="h-4 w-4" /></span>
        <h2 tw-class="text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__backup_and_restore() }}</h2>
      </div>

      <div tw-class="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-800/80 dark:bg-gray-900/20">
        <div tw-class="min-w-0 flex-[1_1_15rem] space-y-1.5">
          <h4 tw-class="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {{ lazyStrings.StorageTab__export_import() }}
            <span tw-class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/30">{{ lazyStrings.StorageTab__experimental() }}</span>
          </h4>
          <p tw-class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.StorageTab__backup_restore_description() }}
          </p>
        </div>
        <button
          @click="showImportExportModal = true"
          tw-class="ml-auto inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-200 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/10"
          data-testid="setting-import-export-button"
        >
          <FileArchiveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
          {{ lazyStrings.StorageTab__manage_data() }}
        </button>
      </div>

      <div tw-class="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-800/80 dark:bg-gray-900/20">
        <div tw-class="min-w-0 flex-[1_1_15rem] space-y-1.5">
          <h4 tw-class="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
            {{ lazyStrings.StorageTab__share_via_url() }}
          </h4>
          <p tw-class="text-xs font-medium text-gray-500 dark:text-gray-400 leading-relaxed">
            {{ lazyStrings.StorageTab__share_url_description() }}
            <span tw-class="mt-1 block text-gray-400 dark:text-gray-500">{{ lazyStrings.StorageTab__large_storage_link_warning() }}</span>
          </p>

          <div tw-class="mt-4 flex flex-wrap gap-4">
            <label tw-class="flex items-center gap-2 cursor-pointer group">
              <SettingsChoiceControl presentation="checkbox"><input
                type="checkbox"
                v-model="excludeChats"
                data-testid="setting-exclude-chats-checkbox"
              /></SettingsChoiceControl>
              <span tw-class="text-xs font-medium text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.StorageTab__exclude_chats() }}</span>
            </label>
            <label
              :tw-class="['flex items-center gap-2 group', excludeChatHistoryDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer']"
            >
              <SettingsChoiceControl presentation="checkbox"><input
                type="checkbox"
                v-model="excludeChatHistory"
                :disabled="excludeChatHistoryDisabled"
                data-testid="setting-exclude-chat-history-checkbox"
              /></SettingsChoiceControl>
              <span tw-class="text-xs font-medium text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.StorageTab__exclude_chat_history() }}</span>
            </label>
            <label tw-class="flex items-center gap-2 cursor-pointer group">
              <SettingsChoiceControl presentation="checkbox"><input
                type="checkbox"
                v-model="excludeAttachments"
                data-testid="setting-exclude-attachments-checkbox"
              /></SettingsChoiceControl>
              <span tw-class="text-xs font-medium text-gray-600 dark:text-gray-400 group-hover:text-gray-800 dark:group-hover:text-gray-200 transition-colors">{{ lazyStrings.StorageTab__exclude_attachments() }}</span>
            </label>
          </div>
        </div>
        <button
          @click="handleCopyExportURL"
          :disabled="isExportingURL"
          tw-class="ml-auto inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-200 dark:hover:border-blue-500/50 dark:hover:bg-blue-500/10"
          data-testid="setting-copy-export-url-button"
        >
          <Loader2Icon v-if="isExportingURL" tw-class="w-4 h-4 animate-spin" />
          <LinkIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />
          <span v-if="isExportingURL">{{ lazyStrings.StorageTab__generating() }}</span>
          <span v-else>{{ lazyStrings.StorageTab__copy_link() }}</span>
        </button>
      </div>
    </section>

    <section tw-class="space-y-3">
      <div tw-class="flex items-center gap-3 pb-1">
        <span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><DatabaseIcon aria-hidden="true" tw-class="h-4 w-4" /></span>
        <h2 tw-class="text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__storage_management() }}</h2>
      </div>

      <div tw-class="space-y-3">
        <label tw-class="ml-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.StorageTab__active_storage_provider() }}</label>
        <div tw-class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <button
            @click="handleStorageChange({ targetType: 'opfs' })"
            type="button"
            :disabled="!isOPFSSupported"
            :tw-class="['flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40',
                        storageType === 'opfs' ? 'border-blue-500 bg-blue-50/40 dark:bg-blue-500/8' : 'border-gray-200/70 bg-white/60 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800/80 dark:bg-gray-900/20 dark:hover:border-gray-700 dark:hover:bg-gray-800/50',
                        !isOPFSSupported ? 'opacity-50 cursor-not-allowed grayscale' : ''
            ]"
            data-testid="storage-opfs"
          >
            <div tw-class="flex items-center justify-between">
              <div tw-class="rounded-lg bg-gray-100/80 p-2 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <HardDriveIcon tw-class="h-4 w-4 text-gray-500 dark:text-gray-400" />
              </div>
              <span v-if="isOPFSSupported" tw-class="text-[10px] bg-green-50 dark:bg-green-900/20 text-green-600/80 dark:text-green-500/80 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">{{ lazyStrings.StorageTab__recommended() }}</span>
              <span v-else tw-class="text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600/80 dark:text-red-500/80 px-2 py-0.5 rounded-full uppercase tracking-wider font-bold">{{ lazyStrings.StorageTab__unsupported() }}</span>
            </div>
            <div>
              <div tw-class="mb-1.5 text-sm font-semibold leading-5 text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__origin_private_file_system() }}</div>
              <div tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.StorageTab__opfs_description() }}</div>
            </div>
          </button>
          <button
            @click="handleStorageChange({ targetType: 'local' })"
            type="button"
            :tw-class="['flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40', storageType === 'local' ? 'border-blue-500 bg-blue-50/40 dark:bg-blue-500/8' : 'border-gray-200/70 bg-white/60 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800/80 dark:bg-gray-900/20 dark:hover:border-gray-700 dark:hover:bg-gray-800/50']"
            data-testid="storage-local"
          >
            <div tw-class="flex items-center justify-between">
              <div tw-class="rounded-lg bg-gray-100/80 p-2 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <HardDriveIcon tw-class="h-4 w-4 text-gray-500 dark:text-gray-400" />
              </div>
            </div>
            <div>
              <div tw-class="mb-1.5 text-sm font-semibold leading-5 text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__local_storage() }}</div>
              <div tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.StorageTab__local_storage_description() }}</div>
            </div>
          </button>
          <button
            @click="handleStorageChange({ targetType: 'memory' })"
            type="button"
            :tw-class="['flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/40', storageType === 'memory' ? 'border-purple-500 bg-purple-50/40 dark:bg-purple-500/8' : 'border-gray-200/70 bg-white/60 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-800/80 dark:bg-gray-900/20 dark:hover:border-gray-700 dark:hover:bg-gray-800/50']"
            data-testid="storage-memory"
          >
            <div tw-class="flex items-center justify-between">
              <div tw-class="rounded-lg bg-gray-100/80 p-2 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                <GhostIcon tw-class="h-4 w-4 text-gray-500 dark:text-gray-400" />
              </div>
            </div>
            <div>
              <div tw-class="mb-1.5 text-sm font-semibold leading-5 text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__ephemeral() }}</div>
              <div tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.StorageTab__ephemeral_description() }}</div>
            </div>
          </button>
        </div>

        <div tw-class="flex items-start gap-2.5 rounded-xl bg-blue-50/50 px-3.5 py-3 text-[11px] text-gray-500 dark:bg-blue-500/5 dark:text-gray-400">
          <InfoIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
          <p tw-class="leading-relaxed">{{ lazyStrings.StorageTab__storage_migration_description() }}</p>
        </div>
      </div>
    </section>

    <section tw-class="space-y-3 border-t border-gray-100 pt-5 dark:border-gray-800">
      <div tw-class="flex items-center gap-3 pb-1">
        <span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"><Trash2Icon aria-hidden="true" tw-class="h-4 w-4" /></span>
        <h2 tw-class="text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__data_cleanup() }}</h2>
      </div>

      <div tw-class="space-y-4 rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-800/80 dark:bg-gray-900/20">
        <div>
          <h4 tw-class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ lazyStrings.StorageTab__clear_conversation_history() }}</h4>
          <p tw-class="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {{ lazyStrings.StorageTab__clear_history_description() }}
          </p>
        </div>
        <button
          @click="handleDeleteAllHistory"
          tw-class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-red-200/70 bg-red-50/40 px-4 py-2 text-xs font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 dark:border-red-900/50 dark:bg-red-500/5 dark:text-red-400 dark:hover:border-red-800 dark:hover:bg-red-500/10"
          data-testid="setting-clear-history-button"
        >
          <Trash2Icon tw-class="w-4 h-4" />
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
