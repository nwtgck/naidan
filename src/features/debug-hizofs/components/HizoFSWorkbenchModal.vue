<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  GaugeIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-vue-next';
import { useDebugHizoFSWorkbench } from '@/features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';
import HizoFSBenchmarkPanel from './HizoFSBenchmarkPanel.vue';
import HizoFSPhysicalInspectorPanel from './HizoFSPhysicalInspectorPanel.vue';

const props = defineProps<{
  physicalInspectionSource?: HizoFSPhysicalInspectionSource;
  physicalInspector?: HizoFSPhysicalInspectionWorker;
}>();

const {
  closeDebugHizoFSWorkbench,
  physicalInspectionSource: installedPhysicalInspectionSource,
} = useDebugHizoFSWorkbench();
const primaryView = ref<'benchmark' | 'physical_inspector'>('physical_inspector');
const openedInspector = ref<HizoFSPhysicalInspectionWorker>();
const openingInspector = ref(false);
const inspectorErrorMessage = ref<string>();
let openGeneration = 0;
let unmounted = false;

const configuredPhysicalInspectionSource = computed(() => (
  props.physicalInspectionSource ?? installedPhysicalInspectionSource.value
));
const activeInspector = computed(() => props.physicalInspector ?? openedInspector.value);

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshPhysicalInspector(): Promise<void> {
  if (props.physicalInspector !== undefined) {
    openedInspector.value = undefined;
    inspectorErrorMessage.value = undefined;
    return;
  }

  const generation = ++openGeneration;
  openingInspector.value = true;
  inspectorErrorMessage.value = undefined;
  openedInspector.value = undefined;
  try {
    const configuredSource = configuredPhysicalInspectionSource.value;
    if (configuredSource === undefined) {
      openingInspector.value = false;
      return;
    }
    const inspector = await configuredSource.open();
    if (unmounted || generation !== openGeneration) return;
    openedInspector.value = inspector;
  } catch (error: unknown) {
    if (unmounted || generation !== openGeneration) return;
    inspectorErrorMessage.value = errorMessage({ error });
  } finally {
    if (!unmounted && generation === openGeneration) openingInspector.value = false;
  }
}

watch(
  () => [configuredPhysicalInspectionSource.value, props.physicalInspector] as const,
  () => {
    openGeneration += 1;
    openedInspector.value = undefined;
    inspectorErrorMessage.value = undefined;
    switch (primaryView.value) {
    case 'physical_inspector':
      void refreshPhysicalInspector();
      return;
    case 'benchmark':
      return;
    default: {
      const _ex: never = primaryView.value;
      throw new Error(`Unhandled HizoFS Workbench view: ${String(_ex)}`);
    }
    }
  },
);

watch(primaryView, view => {
  switch (view) {
  case 'physical_inspector':
    if (activeInspector.value === undefined && !openingInspector.value) void refreshPhysicalInspector();
    return;
  case 'benchmark':
    return;
  default: {
    const _ex: never = view;
    throw new Error(`Unhandled HizoFS Workbench view: ${String(_ex)}`);
  }
  }
});

onMounted(() => {
  void refreshPhysicalInspector();
});

onUnmounted(() => {
  unmounted = true;
  openGeneration += 1;
  openedInspector.value = undefined;
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      refreshPhysicalInspector,
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="closeDebugHizoFSWorkbench">
    <section tw-class="flex h-[min(92vh,960px)] w-[min(96vw,1440px)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-950">
      <header tw-class="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-800">
        <div>
          <h2 tw-class="text-base font-semibold text-gray-900 dark:text-gray-100">HizoFS Workbench</h2>
          <p tw-class="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Read-only persisted-structure inspection and isolated performance studies
          </p>
        </div>
        <button type="button" aria-label="Close HizoFS Workbench" tw-class="rounded p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800" @click="closeDebugHizoFSWorkbench">
          <XIcon tw-class="h-5 w-5" />
        </button>
      </header>

      <nav tw-class="flex gap-1 border-b border-gray-200 px-4 py-2 dark:border-gray-800" aria-label="HizoFS Workbench views">
        <button
          type="button"
          tw-class="inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm"
          :class="primaryView === 'physical_inspector' ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-950' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'"
          data-testid="physical-tab" @click="primaryView = 'physical_inspector'"
        >
          <SearchIcon tw-class="h-4 w-4" />
          Physical Inspector
        </button>
        <button
          type="button"
          tw-class="inline-flex items-center gap-2 rounded px-3 py-1.5 text-sm"
          :class="primaryView === 'benchmark' ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-950' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'"
          data-testid="benchmark-tab" @click="primaryView = 'benchmark'"
        >
          <GaugeIcon tw-class="h-4 w-4" />
          Benchmark
        </button>
      </nav>

      <main tw-class="min-h-0 flex-1 overflow-auto p-4">
        <HizoFSBenchmarkPanel v-if="primaryView === 'benchmark'" />

        <div v-else tw-class="min-h-full">
          <div v-if="openingInspector" tw-class="flex min-h-48 items-center justify-center gap-2 text-sm text-gray-500">
            <LoaderCircleIcon tw-class="h-5 w-5 animate-spin" />
            Opening active encrypted store…
          </div>

          <div v-else-if="inspectorErrorMessage !== undefined" tw-class="mx-auto max-w-2xl rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <p tw-class="font-medium">Physical Inspector is unavailable</p>
            <p tw-class="mt-1 break-words">{{ inspectorErrorMessage }}</p>
            <button type="button" data-testid="retry-inspector" tw-class="mt-3 inline-flex items-center gap-2 rounded border border-current px-3 py-1.5" @click="refreshPhysicalInspector">
              <RefreshCwIcon tw-class="h-4 w-4" />
              Retry
            </button>
          </div>

          <HizoFSPhysicalInspectorPanel
            v-else-if="activeInspector !== undefined"
            :inspector="activeInspector"
          />

          <div v-else tw-class="flex min-h-48 items-center justify-center text-sm text-gray-500">
            No physical Inspector source is available.
          </div>
        </div>
      </main>
    </section>
  </div>
</template>
