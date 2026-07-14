<script setup lang="ts">
/* eslint-disable local-rules/enforce-dependency-directions -- This read-only debug feature intentionally exposes exact persisted encryption DTOs. Mapping could normalize or omit fields and make storage audits unreliable. */
import type {
  OpfsEncryptedStoreHeaderDto,
  OpfsEncryptionStateDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  DatabaseIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  HardDriveIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionDebugSession } from '@/00-storage/service/opfs-encryption/inspection';
import { useDebugOpfsEncryptionInspector } from '@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector';
import { useDebugHizoFSWorkbench } from '@/features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { JsonCodeView } from '@/features/json-viewer';

const { closeDebugOpfsEncryptionInspector } = useDebugOpfsEncryptionInspector();
const { openDebugHizoFSWorkbench } = useDebugHizoFSWorkbench();
const { openFileExplorer } = useFileExplorerModal();

const session = ref<OpfsEncryptionDebugSession>();
const loading = ref(true);
const errorMessage = ref<string>();

const stateJson = computed(() => JSON.stringify(session.value?.state ?? null, undefined, 2));
const headerJson = computed(() => JSON.stringify(session.value?.header ?? null, undefined, 2));
const physicalPath = computed(() => session.value?.physicalPath.join('/') ?? '');
const keySlotCount = computed(() => session.value?.state.keySlots.length ?? 0);

onMounted(reload);
onUnmounted(() => {
  void disposeSession();
});

async function disposeSession(): Promise<void> {
  const previous = session.value;
  session.value = undefined;
  await previous?.dispose();
}

async function reload(): Promise<void> {
  loading.value = true;
  errorMessage.value = undefined;
  await disposeSession();
  try {
    session.value = await storageService.createOpfsEncryptionDebugSession();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function openRawOpfs(): void {
  closeDebugOpfsEncryptionInspector();
  openFileExplorer({ options: { kind: 'opfs-root' } });
}

function openDecryptedFileSystem(): void {
  const activeSession = session.value;
  if (activeSession === undefined) return;
  closeDebugOpfsEncryptionInspector();
  openFileExplorer({
    options: {
      kind: 'storage-directory',
      title: 'Decrypted HizoFS',
      rootName: 'HizoFS root',
      handle: activeSession.decryptedRoot,
      readOnly: true,
      initialPath: undefined,
    },
  });
}

function openHizoFS(): void {
  closeDebugOpfsEncryptionInspector();
  openDebugHizoFSWorkbench();
}

// Keep the exact DTO types referenced in this audit-only feature so future
// persisted fields cannot silently disappear behind a mapped view model.
const _persistedDtoAuditTypes: readonly [
  OpfsEncryptionStateDto | undefined,
  OpfsEncryptedStoreHeaderDto | undefined,
] = [undefined, undefined];
void _persistedDtoAuditTypes;

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: { reload },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div tw-class="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-3 sm:p-6" @click.self="closeDebugOpfsEncryptionInspector">
      <section role="dialog" aria-modal="true" aria-labelledby="opfs-encryption-inspector-title" tw-class="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            <ShieldCheckIcon tw-class="h-5 w-5" />
          </div>
          <div tw-class="min-w-0 flex-1">
            <h1 id="opfs-encryption-inspector-title" tw-class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">OPFS Encryption Inspector</h1>
            <p tw-class="truncate text-xs text-gray-500 dark:text-gray-400">Naidan encryption control state, key slots, and encrypted store selection</p>
          </div>
          <button type="button" aria-label="Reload OPFS encryption inspection" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" :disabled="loading" @click="reload">
            <RefreshCwIcon :tw-class="['h-4 w-4', loading ? 'animate-spin' : '']" />
          </button>
          <button type="button" aria-label="Close OPFS encryption inspector" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="closeDebugOpfsEncryptionInspector">
            <XIcon tw-class="h-4 w-4" />
          </button>
        </header>

        <div v-if="loading" tw-class="flex min-h-72 flex-1 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <LoaderCircleIcon tw-class="h-5 w-5 animate-spin" />
          Reading OPFS encryption control state…
        </div>
        <div v-else-if="errorMessage" tw-class="flex min-h-72 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
          <div tw-class="max-w-2xl break-words font-mono text-sm text-red-700 dark:text-red-300">{{ errorMessage }}</div>
          <button type="button" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800" @click="reload">Retry</button>
        </div>

        <template v-else-if="session">
          <div tw-class="grid shrink-0 gap-3 border-b border-gray-200 p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-gray-700">
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">State</div>
              <div tw-class="mt-1 font-mono text-xs text-gray-800 dark:text-gray-200">{{ session.state.state }}</div>
            </div>
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Key slots</div>
              <div tw-class="mt-1 font-mono text-xs text-gray-800 dark:text-gray-200">{{ keySlotCount }}</div>
            </div>
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Active store</div>
              <div tw-class="mt-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ session.header.encryptedStoreId }}</div>
            </div>
            <div tw-class="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-950">
              <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Backing path</div>
              <div tw-class="mt-1 break-all font-mono text-xs text-gray-800 dark:text-gray-200">{{ physicalPath }}</div>
            </div>
          </div>

          <div tw-class="flex shrink-0 flex-wrap gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <button type="button" data-testid="opfs-encryption-open-hizofs" tw-class="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700" @click="openHizoFS">
              <HardDriveIcon tw-class="h-4 w-4" />
              Open HizoFS Workbench
            </button>
            <button type="button" data-testid="opfs-encryption-open-decrypted" tw-class="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800" @click="openDecryptedFileSystem">
              <FolderOpenIcon tw-class="h-4 w-4" />
              Open decrypted File Explorer
            </button>
            <button type="button" data-testid="opfs-encryption-open-raw" tw-class="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800" @click="openRawOpfs">
              <DatabaseIcon tw-class="h-4 w-4" />
              Open raw OPFS
              <ExternalLinkIcon tw-class="h-3.5 w-3.5" />
            </button>
          </div>

          <div tw-class="grid min-h-0 flex-1 overflow-auto lg:grid-cols-2">
            <section tw-class="min-w-0 border-b border-gray-200 lg:border-b-0 lg:border-r dark:border-gray-700">
              <header tw-class="border-b border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Persisted encryption state DTO</header>
              <JsonCodeView :source="stateJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
            </section>
            <section tw-class="min-w-0">
              <header tw-class="border-b border-gray-200 px-4 py-2 text-xs font-semibold text-gray-700 dark:border-gray-700 dark:text-gray-200">Persisted encrypted store header DTO</header>
              <JsonCodeView :source="headerJson" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
            </section>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>
