<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  DatabaseIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { EncryptedStorageDebugSession } from '@/00-storage/service/opfs-encryption/inspection';
import { useDebugEncryptedStorageInspector } from '@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { JsonCodeView } from '@/features/json-viewer';

const { closeDebugEncryptedStorageInspector } = useDebugEncryptedStorageInspector();
const { openFileExplorer } = useFileExplorerModal();

const session = ref<EncryptedStorageDebugSession>();
const loading = ref(true);
const errorMessage = ref<string>();

const stateJson = computed(() => JSON.stringify(session.value?.state ?? null, undefined, 2));
const headerJson = computed(() => JSON.stringify(session.value?.header ?? null, undefined, 2));
const encryptedOpfsJson = computed(() => JSON.stringify(session.value?.encryptedOpfs ?? null, undefined, 2));
const physicalPath = computed(() => session.value?.physicalPath.join('/') ?? '');

onMounted(async () => {
  await reload();
});

async function reload(): Promise<void> {
  loading.value = true;
  errorMessage.value = undefined;
  try {
    session.value = await storageService.createEncryptedStorageDebugSession();
  } catch (error) {
    session.value = undefined;
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function openPhysicalBackingStore(): void {
  closeDebugEncryptedStorageInspector();
  openFileExplorer({ options: { kind: 'opfs-root' } });
}

function openDecryptedFileSystem(): void {
  const activeSession = session.value;
  if (activeSession === undefined) {
    return;
  }
  closeDebugEncryptedStorageInspector();
  openFileExplorer({
    options: {
      kind: 'wesh-mounts',
      title: 'Decrypted EncryptedOpfs',
      rootName: 'EncryptedOpfs root',
      mounts: [{
        type: 'storage_directory',
        path: '/',
        handle: activeSession.decryptedRoot,
        readOnly: true,
      }],
      initialPath: undefined,
    },
  });
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      reload,
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div tw-class="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-3 sm:p-6" @click.self="closeDebugEncryptedStorageInspector">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="encrypted-storage-inspector-title"
        tw-class="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900"
      >
        <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <ShieldCheckIcon tw-class="h-5 w-5" />
          </div>
          <div tw-class="min-w-0 flex-1">
            <h1 id="encrypted-storage-inspector-title" tw-class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
              Encrypted Storage Inspector
            </h1>
            <p tw-class="truncate text-xs text-gray-500 dark:text-gray-400">
              Bridge between the physical backing store and the decrypted EncryptedOpfs namespace
            </p>
          </div>
          <button
            type="button"
            aria-label="Reload encrypted storage inspection"
            tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            :disabled="loading"
            @click="reload"
          >
            <RefreshCwIcon :tw-class="['h-4 w-4', loading ? 'animate-spin' : '']" />
          </button>
          <button
            type="button"
            aria-label="Close encrypted storage inspector"
            tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
            @click="closeDebugEncryptedStorageInspector"
          >
            <XIcon tw-class="h-4 w-4" />
          </button>
        </header>

        <div v-if="loading" tw-class="flex min-h-72 flex-1 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <LoaderCircleIcon tw-class="h-5 w-5 animate-spin" />
          Reading EncryptedOpfs state…
        </div>

        <div v-else-if="errorMessage" tw-class="flex min-h-72 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
          <div tw-class="max-w-2xl break-words font-mono text-sm text-red-700 dark:text-red-300">{{ errorMessage }}</div>
          <button
            type="button"
            tw-class="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            @click="reload"
          >
            Retry
          </button>
        </div>

        <template v-else-if="session">
          <div tw-class="grid shrink-0 gap-3 border-b border-gray-200 p-4 md:grid-cols-2 lg:grid-cols-4 dark:border-gray-700">
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Encrypted store</div>
              <div tw-class="mt-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ session.header.encryptedStoreId }}</div>
            </div>
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">File system</div>
              <div tw-class="mt-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ session.encryptedOpfs.descriptor.fileSystemId }}</div>
            </div>
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Active revision</div>
              <div tw-class="mt-1 font-mono text-xs text-gray-800 dark:text-gray-200">{{ session.encryptedOpfs.activeCommit.revision }}</div>
            </div>
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Physical backing path</div>
              <div tw-class="mt-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ physicalPath }}</div>
            </div>
          </div>

          <div tw-class="flex shrink-0 flex-wrap gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <button
              type="button"
              data-testid="encrypted-storage-open-decrypted"
              tw-class="flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700"
              @click="openDecryptedFileSystem"
            >
              <FolderOpenIcon tw-class="h-4 w-4" />
              Open decrypted File Explorer
            </button>
            <button
              type="button"
              data-testid="encrypted-storage-open-physical"
              tw-class="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
              @click="openPhysicalBackingStore"
            >
              <DatabaseIcon tw-class="h-4 w-4" />
              Open raw OPFS Explorer
              <ExternalLinkIcon tw-class="h-3.5 w-3.5" />
            </button>
          </div>

          <div tw-class="grid min-h-0 flex-1 overflow-auto lg:grid-cols-3">
            <section tw-class="min-w-0 border-b border-gray-200 lg:border-b-0 lg:border-r dark:border-gray-700">
              <header tw-class="border-b border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Naidan encryption state</header>
              <JsonCodeView :source="stateJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
            </section>
            <section tw-class="min-w-0 border-b border-gray-200 lg:border-b-0 lg:border-r dark:border-gray-700">
              <header tw-class="border-b border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Encrypted store header</header>
              <JsonCodeView :source="headerJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
            </section>
            <section tw-class="min-w-0">
              <header tw-class="border-b border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">EncryptedOpfs active state</header>
              <JsonCodeView :source="encryptedOpfsJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
            </section>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>
