<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import {
  DatabaseIcon,
  Loader2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-vue-next';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { useOpfsEncryptionTransition } from '@/features/opfs-encryption/composables/useOpfsEncryptionTransition';
import { lazyStrings } from '@/strings';
import OpfsEncryptionTransitionProgress from './OpfsEncryptionTransitionProgress.vue';

const FileExplorerModal = defineAsyncComponent(
  () => import('@/features/file-explorer/components/FileExplorerModal.vue'),
);
const { failed, failureMessage, progress } = useOpfsEncryptionTransition();
const { isFileExplorerOpen, openFileExplorer } = useFileExplorerModal();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    data-testid="opfs-encryption-transition-view"
    tw-class="fixed inset-0 z-[120] bg-gray-950/70 backdrop-blur-md flex items-center justify-center p-5"
  >
    <section tw-class="w-full max-w-lg rounded-[2rem] border border-white/10 bg-white dark:bg-gray-900 shadow-2xl px-8 py-9 text-center space-y-5">
      <div
        tw-class="mx-auto w-14 h-14 rounded-2xl text-white flex items-center justify-center shadow-lg relative"
        :class="failed ? 'bg-red-600 shadow-red-500/30' : 'bg-blue-600 shadow-blue-500/30'"
      >
        <ShieldAlertIcon v-if="failed" tw-class="w-7 h-7" />
        <ShieldCheckIcon v-else tw-class="w-7 h-7" />
        <Loader2Icon v-if="!failed" tw-class="absolute -right-2 -bottom-2 w-6 h-6 rounded-full bg-white dark:bg-gray-900 text-blue-600 p-1 animate-spin" />
      </div>
      <div tw-class="space-y-2">
        <h2 tw-class="text-xl font-extrabold text-gray-900 dark:text-white tracking-tight">
          {{ failed ? lazyStrings.opfsEncryption__encrypted_storage_needs_recovery() : lazyStrings.opfsEncryption__updating_encrypted_storage() }}
        </h2>
        <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {{ failed ? failureMessage : lazyStrings.opfsEncryption__copying_and_verifying_complete_opfs_storage() }}
        </p>
      </div>
      <div
        v-if="failed"
        tw-class="rounded-2xl bg-red-50 dark:bg-red-950/25 border border-red-100 dark:border-red-900/50 px-4 py-3 text-xs leading-relaxed text-red-800 dark:text-red-300 space-y-3"
      >
        <p>{{ lazyStrings.opfsEncryption__raw_opfs_access_does_not_decrypt() }}</p>
        <button
          type="button"
          data-testid="opfs-encryption-transition-open-raw-opfs"
          tw-class="inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 dark:border-red-900/60 bg-white/80 dark:bg-gray-900 px-4 py-2.5 text-xs font-bold text-red-800 dark:text-red-300"
          @click="openFileExplorer({ options: { kind: 'opfs-root' } })"
        >
          <DatabaseIcon tw-class="w-4 h-4" />
          {{ lazyStrings.opfsEncryption__open_raw_opfs_explorer() }}
        </button>
      </div>
      <div v-else tw-class="space-y-4">
        <OpfsEncryptionTransitionProgress :progress="progress" />
        <div tw-class="rounded-2xl bg-blue-50 dark:bg-blue-950/25 border border-blue-100 dark:border-blue-900/50 px-4 py-3 text-xs leading-relaxed text-blue-800 dark:text-blue-300">
          {{ lazyStrings.opfsEncryption__source_remains_until_verified() }}
        </div>
      </div>
    </section>
  </div>

  <FileExplorerModal v-if="isFileExplorerOpen" />
</template>
