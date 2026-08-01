<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types';
import type { PersistenceControlInspectionSource } from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-source';
import {
  ExternalLinkIcon,
  FolderOpenIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-vue-next';
import { usePersistenceControlInspector } from '@/features/debug-opfs-encryption/composables/usePersistenceControlInspector';
import { useDebugHizoFSWorkbench } from '@/features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import PersistenceControlInspectionPanel from './PersistenceControlInspectionPanel.vue';

const props = defineProps<{
  persistenceControlInspectionSource?: PersistenceControlInspectionSource;
}>();

const {
  closePersistenceControlInspector,
  persistenceControlInspectionSource: installedInspectionSource,
} = usePersistenceControlInspector();
const { openDebugHizoFSWorkbench } = useDebugHizoFSWorkbench();
const { openFileExplorer } = useFileExplorerModal();

const activeInspectionSource = computed(() => (
  props.persistenceControlInspectionSource ?? installedInspectionSource.value
));

const inspection = ref<PersistenceControlInspection>();
const loading = ref(false);
const errorMessage = ref<string>();
let inspectionGeneration = 0;
let unmounted = false;

function errorText({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads detached Persistence Control evidence through a one-shot source.
 * Clearing the previous result before awaiting is security-significant: a
 * failed refresh must never leave stale proof-valid state on screen.
 */
async function reload(): Promise<void> {
  const generation = ++inspectionGeneration;
  inspection.value = undefined;
  errorMessage.value = undefined;
  const source = activeInspectionSource.value;
  if (source === undefined) {
    loading.value = false;
    return;
  }

  loading.value = true;
  try {
    const nextInspection = await source.inspectPersistenceControl();
    if (unmounted || generation !== inspectionGeneration) return;
    inspection.value = nextInspection;
  } catch (error: unknown) {
    if (unmounted || generation !== inspectionGeneration) return;
    errorMessage.value = errorText({ error });
  } finally {
    if (!unmounted && generation === inspectionGeneration) loading.value = false;
  }
}

function openRawOpfs(): void {
  closePersistenceControlInspector();
  openFileExplorer({ options: { kind: 'opfs-root' } });
}

async function openHizoFS(): Promise<void> {
  closePersistenceControlInspector();
  await openDebugHizoFSWorkbench();
}

watch(
  activeInspectionSource,
  () => {
    void reload();
  },
);

onMounted(() => {
  void reload();
});

onUnmounted(() => {
  unmounted = true;
  inspectionGeneration += 1;
  inspection.value = undefined;
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: { reload },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div tw-class="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-3 sm:p-6" @click.self="closePersistenceControlInspector">
      <section role="dialog" aria-modal="true" aria-labelledby="persistence-control-inspector-title" tw-class="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <header tw-class="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            <ShieldCheckIcon tw-class="h-5 w-5" />
          </div>
          <div tw-class="min-w-0 flex-1">
            <h1 id="persistence-control-inspector-title" tw-class="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">Persistence Control Inspector</h1>
            <p tw-class="truncate text-xs text-gray-500 dark:text-gray-400">Read-only A/B authority, proof, transition, and routing evidence</p>
          </div>
          <button type="button" aria-label="Reload Persistence Control inspection" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800" :disabled="loading" @click="reload">
            <RefreshCwIcon :tw-class="['h-4 w-4', loading ? 'animate-spin' : '']" />
          </button>
          <button type="button" aria-label="Close Persistence Control inspector" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800" @click="closePersistenceControlInspector">
            <XIcon tw-class="h-4 w-4" />
          </button>
        </header>

        <div v-if="loading" data-testid="persistence-control-loading" tw-class="flex min-h-72 flex-1 items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <LoaderCircleIcon tw-class="h-5 w-5 animate-spin" />
          Reading Persistence Control evidence…
        </div>

        <div v-else-if="errorMessage !== undefined" data-testid="persistence-control-inspection-error" tw-class="flex min-h-72 flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center">
          <div tw-class="max-w-2xl break-words font-mono text-sm text-red-700 dark:text-red-300">{{ errorMessage }}</div>
          <button type="button" data-testid="persistence-control-retry" tw-class="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800" @click="reload">Retry</button>
        </div>

        <PersistenceControlInspectionPanel
          v-else-if="inspection !== undefined"
          :inspection="inspection"
        />

        <div v-else data-testid="persistence-control-source-unavailable" tw-class="flex min-h-72 flex-1 items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-gray-400">
          The production read-only Persistence Control source is not connected yet.
        </div>

        <footer tw-class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700">
          <button type="button" data-testid="persistence-control-open-raw" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800" @click="openRawOpfs">
            <FolderOpenIcon tw-class="h-4 w-4" />
            Raw OPFS
          </button>
          <button type="button" data-testid="persistence-control-open-hizofs" tw-class="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700" @click="openHizoFS">
            <ExternalLinkIcon tw-class="h-4 w-4" />
            HizoFS Workbench
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
