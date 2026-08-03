<script setup lang="ts">
import {
  ChevronDownIcon,
  ClipboardIcon,
  DownloadIcon,
  PlayIcon,
  SquareIcon,
  UploadIcon,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  createHizoFSBenchmarkPresetConfiguration,
  estimateHizoFSBenchmarkWrittenBytes,
} from '@/features/debug-hizofs/benchmark/presets';
import {
  serializeHizoFSBenchmarkConfiguration,
  serializeHizoFSBenchmarkFullReport,
  serializeHizoFSBenchmarkStudyFullReport,
  serializeHizoFSBenchmarkStudySummaryReport,
  serializeHizoFSBenchmarkSummaryReport,
} from '@/features/debug-hizofs/benchmark/report';
import {
  createHizoFSBenchmarkStudyPlan,
  createHizoFSBenchmarkStudyReport,
} from '@/features/debug-hizofs/benchmark/studies';
import {
  hizoFSBenchmarkConfigurationSchema,
  type HizoFSBenchmarkBackendMode,
  type HizoFSBenchmarkConfiguration,
  type HizoFSBenchmarkPreset,
  type HizoFSBenchmarkProgress,
  type HizoFSBenchmarkReport,
  type HizoFSBenchmarkStudyKind,
  type HizoFSBenchmarkStudyReport,
  type HizoFSBenchmarkWorkload,
} from '@/features/debug-hizofs/benchmark/types';
import { createHizoFSBenchmarkWorkerClient } from '@/features/debug-hizofs/benchmark/client';
import type { HizoFSBenchmarkWorkerClient } from '@/features/debug-hizofs/benchmark/worker-client';

type BenchmarkRunMode = 'single' | HizoFSBenchmarkStudyKind;

type StudyVariantProgress = {
  readonly index: number;
  readonly total: number;
  readonly label: string;
};

type StudyResultRow = {
  readonly key: string;
  readonly variantLabel: string;
  readonly status: HizoFSBenchmarkReport['status'];
  readonly configurationSummary: string;
  readonly caseLabel: string;
  readonly rawMedian: number | undefined;
  readonly hizoFSMedian: number | undefined;
  readonly durationRatio: number | undefined;
};

const configuration = ref<HizoFSBenchmarkConfiguration>(
  createHizoFSBenchmarkPresetConfiguration({ preset: 'standard' }),
);
const runMode = ref<BenchmarkRunMode>('single');
const advancedOpen = ref(false);
const configurationImportOpen = ref(false);
const configurationImportText = ref('');
const configurationImportError = ref<string>();
const running = ref(false);
const cancelling = ref(false);
const cancelRequested = ref(false);
const cleaningData = ref(false);
const progress = ref<HizoFSBenchmarkProgress>();
const studyVariantProgress = ref<StudyVariantProgress>();
const report = ref<HizoFSBenchmarkReport>();
const studyReport = ref<HizoFSBenchmarkStudyReport>();
const errorMessage = ref<string>();
const copyStatus = ref<string>();
let benchmarkClient: HizoFSBenchmarkWorkerClient | undefined;

const estimatedWrittenBytes = computed(() => {
  const parsed = hizoFSBenchmarkConfigurationSchema.safeParse(configuration.value);
  if (!parsed.success) return 0;
  switch (runMode.value) {
  case 'single':
    return estimateHizoFSBenchmarkWrittenBytes({ configuration: parsed.data });
  case 'policy_matrix':
  case 'large_write':
  case 'lifecycle_matrix':
  case 'bulk_transaction':
  case 'garbage_collection_policy':
  case 'diagnostics_overhead':
    return createHizoFSBenchmarkStudyPlan({
      studyKind: runMode.value,
      baseConfiguration: parsed.data,
    }).reduce((total, variant) => (
      total + estimateHizoFSBenchmarkWrittenBytes({
        configuration: variant.configuration,
      })
    ), 0);
  default: {
    const _ex: never = runMode.value;
    throw new Error(`Unhandled benchmark run mode: ${String(_ex)}`);
  }
  }
});
const selectedWorkloadLabels = computed(() => configuration.value.workloads
  .map(workload => workloadLabel({ workload }))
  .join(', '));

const studyResultRows = computed<readonly StudyResultRow[]>(() => {
  const currentStudyReport = studyReport.value;
  if (currentStudyReport === undefined) return [];
  return currentStudyReport.variants.flatMap(variant => {
    const configurationSummary = summarizeStudyConfiguration({
      configuration: variant.report.configuration,
    });
    if (variant.report.results.length === 0) {
      return [{
        key: `${variant.variantId}/empty`,
        variantLabel: variant.label,
        status: variant.report.status,
        configurationSummary,
        caseLabel: 'No completed cases',
        rawMedian: undefined,
        hizoFSMedian: undefined,
        durationRatio: undefined,
      }];
    }
    return variant.report.results.map(result => ({
      key: `${variant.variantId}/${result.workload}/${result.caseId}`,
      variantLabel: variant.label,
      status: variant.report.status,
      configurationSummary,
      caseLabel: result.label,
      rawMedian: result.backends.rawOpfs?.durationMs.median,
      hizoFSMedian: result.backends.hizofs?.durationMs.median,
      durationRatio: result.comparison?.durationRatio,
    }));
  });
});
const progressPercent = computed(() => {
  const value = progress.value;
  if (value === undefined) return 0;
  return Math.min((value.completedUnits / value.totalUnits) * 100, 100);
});

function setPreset({ preset }: { preset: HizoFSBenchmarkPreset }): void {
  switch (preset) {
  case 'custom':
    configuration.value = {
      ...configuration.value,
      preset: 'custom',
    };
    break;
  case 'quick':
  case 'standard':
  case 'stress': {
    const previous = configuration.value;
    const presetConfiguration = createHizoFSBenchmarkPresetConfiguration({ preset });
    configuration.value = {
      ...presetConfiguration,
      backendMode: previous.backendMode,
      runLabel: previous.runLabel,
      storeLifecycle: previous.storeLifecycle,
      workloads: getWorkloadsForBackendMode({
        workloads: presetConfiguration.workloads,
        backendMode: previous.backendMode,
      }),
      benchmarkDataRetention: previous.benchmarkDataRetention,
    };
    break;
  }
  default: {
    const _ex: never = preset;
    throw new Error(`Unhandled HizoFS benchmark preset: ${String(_ex)}`);
  }
  }
}

function setBackendMode({ backendMode }: { backendMode: HizoFSBenchmarkBackendMode }): void {
  configuration.value = {
    ...configuration.value,
    backendMode,
    workloads: getWorkloadsForBackendMode({
      workloads: configuration.value.workloads,
      backendMode,
    }),
  };
}

function getWorkloadsForBackendMode({
  workloads,
  backendMode,
}: {
  workloads: readonly HizoFSBenchmarkWorkload[];
  backendMode: HizoFSBenchmarkBackendMode;
}): HizoFSBenchmarkWorkload[] {
  switch (backendMode) {
  case 'raw_opfs_only': {
    const filtered = workloads.filter(workload => workload !== 'hizofs_maintenance');
    return filtered.length === 0 ? ['small_files'] : filtered;
  }
  case 'compare':
  case 'hizofs_only':
    return [...workloads];
  default: {
    const _ex: never = backendMode;
    throw new Error(`Unhandled HizoFS benchmark backend mode: ${String(_ex)}`);
  }
  }
}

function markCustom(): void {
  configuration.value = {
    ...configuration.value,
    preset: 'custom',
  };
}

function toggleWorkload({ workload }: { workload: HizoFSBenchmarkWorkload }): void {
  const selected = configuration.value.workloads.includes(workload);
  const next = selected
    ? configuration.value.workloads.filter(value => value !== workload)
    : [...configuration.value.workloads, workload];
  if (next.length === 0) return;
  configuration.value = {
    ...configuration.value,
    preset: 'custom',
    workloads: next,
  };
}

async function runBenchmark(): Promise<void> {
  if (running.value) return;
  errorMessage.value = undefined;
  report.value = undefined;
  studyReport.value = undefined;
  progress.value = undefined;
  studyVariantProgress.value = undefined;
  running.value = true;
  cancelling.value = false;
  cancelRequested.value = false;
  try {
    const parsed = hizoFSBenchmarkConfigurationSchema.parse(configuration.value);
    benchmarkClient = await createHizoFSBenchmarkWorkerClient();
    if (cancelRequested.value) return;
    const currentRunMode = runMode.value;
    let studyKind: HizoFSBenchmarkStudyKind;
    switch (currentRunMode) {
    case 'single':
      report.value = await benchmarkClient.runBenchmark({
        configuration: parsed,
        onProgress: ({ progress: nextProgress }) => {
          progress.value = nextProgress;
        },
      });
      return;
    case 'policy_matrix':
    case 'large_write':
    case 'lifecycle_matrix':
    case 'bulk_transaction':
    case 'garbage_collection_policy':
    case 'diagnostics_overhead':
      studyKind = currentRunMode;
      break;
    default: {
      const _ex: never = currentRunMode;
      throw new Error(`Unhandled benchmark run mode: ${String(_ex)}`);
    }
    }

    const plan = createHizoFSBenchmarkStudyPlan({
      studyKind,
      baseConfiguration: parsed,
    });
    const completedVariants: Array<{
      readonly variantId: string;
      readonly label: string;
      readonly report: HizoFSBenchmarkReport;
    }> = [];
    const studyId = createStudyId();
    const generatedAt = new Date().toISOString();
    const updateStudyReport = (): void => {
      studyReport.value = createHizoFSBenchmarkStudyReport({
        studyId,
        studyKind,
        generatedAt,
        baseConfiguration: parsed,
        plannedVariantCount: plan.length,
        variants: completedVariants,
      });
    };
    for (const [index, variant] of plan.entries()) {
      if (cancelRequested.value) break;
      studyVariantProgress.value = {
        index: index + 1,
        total: plan.length,
        label: variant.label,
      };
      const variantReport = await benchmarkClient.runBenchmark({
        configuration: variant.configuration,
        onProgress: ({ progress: nextProgress }) => {
          progress.value = nextProgress;
        },
      });
      completedVariants.push({
        variantId: variant.variantId,
        label: variant.label,
        report: variantReport,
      });
      updateStudyReport();
      if (
        cancelRequested.value
        || !shouldContinueStudy({ status: variantReport.status })
      ) {
        break;
      }
    }
    updateStudyReport();
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  } finally {
    const client = benchmarkClient;
    benchmarkClient = undefined;
    if (client !== undefined) {
      try {
        await client.dispose();
      } catch (error) {
        errorMessage.value ??= toErrorMessage({ error });
      }
    }
    running.value = false;
    cancelling.value = false;
    cancelRequested.value = false;
    studyVariantProgress.value = undefined;
  }
}

async function cleanBenchmarkData(): Promise<void> {
  if (running.value || cleaningData.value) return;
  cleaningData.value = true;
  errorMessage.value = undefined;
  let client: HizoFSBenchmarkWorkerClient | undefined;
  try {
    client = await createHizoFSBenchmarkWorkerClient();
    await client.cleanBenchmarkData();
    copyStatus.value = 'Benchmark data cleaned';
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  } finally {
    try {
      await client?.dispose();
    } catch (error) {
      errorMessage.value ??= toErrorMessage({ error });
    }
    cleaningData.value = false;
  }
}

async function cancelBenchmark(): Promise<void> {
  if (!running.value || cancelling.value) return;
  cancelling.value = true;
  cancelRequested.value = true;
  const client = benchmarkClient;
  if (client === undefined) return;
  try {
    await client.cancelCurrentOperation();
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  }
}

async function copyConfiguration(): Promise<void> {
  await copyText({
    text: serializeHizoFSBenchmarkConfiguration({ configuration: configuration.value }),
    status: 'Configuration JSON copied',
  });
}

function openConfigurationImport(): void {
  configurationImportText.value = serializeHizoFSBenchmarkConfiguration({
    configuration: configuration.value,
  });
  configurationImportError.value = undefined;
  configurationImportOpen.value = true;
}

function applyConfigurationImport(): void {
  try {
    configuration.value = hizoFSBenchmarkConfigurationSchema.parse(
      JSON.parse(configurationImportText.value),
    );
    configurationImportError.value = undefined;
    configurationImportOpen.value = false;
  } catch (error) {
    configurationImportError.value = toErrorMessage({ error });
  }
}

async function copySummaryJson(): Promise<void> {
  const currentStudyReport = studyReport.value;
  if (currentStudyReport !== undefined) {
    await copyText({
      text: serializeHizoFSBenchmarkStudySummaryReport({
        report: currentStudyReport,
      }),
      status: 'Study summary JSON copied',
    });
    return;
  }
  const currentReport = report.value;
  if (currentReport === undefined) return;
  await copyText({
    text: serializeHizoFSBenchmarkSummaryReport({ report: currentReport }),
    status: 'Summary JSON copied',
  });
}

async function copyHumanSummary(): Promise<void> {
  const currentStudyReport = studyReport.value;
  if (currentStudyReport !== undefined) {
    const lines = [
      `HizoFS benchmark study: ${currentStudyReport.status}`,
      `Study ID: ${currentStudyReport.studyId}`,
      `Study kind: ${currentStudyReport.studyKind}`,
      '',
      '| Variant | Status | Case | HizoFS median | Raw median |',
      '|---|---|---|---:|---:|',
      ...currentStudyReport.variants.flatMap(variant => (
        variant.report.results.map(result => (
          `| ${variant.label} | ${variant.report.status} | ${result.label} | ${formatDuration({ value: result.backends.hizofs?.durationMs.median })} | ${formatDuration({ value: result.backends.rawOpfs?.durationMs.median })} |`
        ))
      )),
    ];
    await copyText({
      text: lines.join('\n'),
      status: 'Study Markdown summary copied',
    });
    return;
  }
  const currentReport = report.value;
  if (currentReport === undefined) return;
  const lines = [
    `HizoFS benchmark: ${currentReport.status}`,
    `Run ID: ${currentReport.runId}`,
    `Backends: ${currentReport.configuration.backendMode}`,
    `Store lifecycle: ${currentReport.configuration.storeLifecycle}`,
    `Backing diagnostics: ${currentReport.configuration.backingStoreDiagnosticsMode}`,
    '',
    '| Case | Raw OPFS | HizoFS | HizoFS / Raw |',
    '|---|---:|---:|---:|',
    ...currentReport.results.map(result => {
      const raw = result.backends.rawOpfs?.durationMs.median;
      const hizofs = result.backends.hizofs?.durationMs.median;
      const ratio = result.comparison?.durationRatio;
      return `| ${result.label} | ${formatDuration({ value: raw })} | ${formatDuration({ value: hizofs })} | ${ratio === undefined ? '—' : `${ratio.toFixed(2)}×`} |`;
    }),
  ];
  await copyText({ text: lines.join('\n'), status: 'Markdown summary copied' });
}

function downloadFullJson(): void {
  const currentStudyReport = studyReport.value;
  if (currentStudyReport !== undefined) {
    downloadJson({
      text: serializeHizoFSBenchmarkStudyFullReport({ report: currentStudyReport }),
      fileName: `hizofs-benchmark-study-${currentStudyReport.studyId}.json`,
    });
    return;
  }
  const currentReport = report.value;
  if (currentReport === undefined) return;
  downloadJson({
    text: serializeHizoFSBenchmarkFullReport({ report: currentReport }),
    fileName: `hizofs-benchmark-${currentReport.runId}.json`,
  });
}

function downloadJson({
  text,
  fileName,
}: {
  text: string;
  fileName: string;
}): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText({ text, status }: { text: string; status: string }): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.value = status;
  } catch (error) {
    errorMessage.value = toErrorMessage({ error });
  }
}

function summarizeStudyConfiguration({
  configuration: value,
}: {
  configuration: HizoFSBenchmarkConfiguration;
}): string {
  const policy = value.hizoFSRuntimePolicy;
  const garbageCollection = value.hizoFSMaintenance.garbageCollectionSweep;
  return [
    value.backendMode,
    value.storeLifecycle,
    `diag=${value.backingStoreDiagnosticsMode}`,
    value.workloads.join('+'),
    `chunk=${formatBytes({ value: policy.fileChunkSize })}`,
    `write=${String(policy.fileChunkWriteConcurrency)}`,
    `read=${String(policy.fileChunkReadPrefetchConcurrency)}`,
    `handles=${String(policy.backingFileHandleCacheEntryLimit)}`,
    `chunks=${formatBytes({ value: policy.fileChunkCacheByteLimit })}/${policy.fileChunkCacheAdmission}`,
    `gc=${String(garbageCollection.removeConcurrency)}x/${String(garbageCollection.maximumRemovalsPerSlice)}/${String(garbageCollection.maximumSliceDurationMs)}ms`,
  ].join(' · ');
}

function formatBytes({ value }: { value: number }): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${String(value)} B`;
}

function formatDuration({ value }: { value: number | undefined }): string {
  return value === undefined ? '—' : `${value.toFixed(2)} ms`;
}

function formatRate({
  result,
}: {
  result: HizoFSBenchmarkReport['results'][number]['backends']['rawOpfs'];
}): string {
  if (result === undefined) return '—';
  if (result.throughputBytesPerSecond !== undefined) {
    return `${formatBytes({ value: result.throughputBytesPerSecond })}/s`;
  }
  if (result.operationsPerSecond !== undefined) {
    return `${result.operationsPerSecond.toFixed(1)} ops/s`;
  }
  return '—';
}

function workloadLabel({ workload }: { workload: HizoFSBenchmarkWorkload }): string {
  switch (workload) {
  case 'small_files': return 'Small files';
  case 'sequential_io': return 'Sequential I/O';
  case 'random_access': return 'Random access';
  case 'directory_operations': return 'Directory operations';
  case 'bulk_operations': return 'Bulk operations';
  case 'hizofs_maintenance': return 'HizoFS maintenance';
  default: {
    const _ex: never = workload;
    return String(_ex);
  }
  }
}

function shouldContinueStudy({
  status,
}: {
  status: HizoFSBenchmarkReport['status'];
}): boolean {
  switch (status) {
  case 'completed':
    return true;
  case 'cancelled':
  case 'failed':
    return false;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled benchmark report status: ${String(_ex)}`);
  }
  }
}

function createStudyId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

function toErrorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      configuration,
      runMode,
      report,
      studyReport,
      progress,
    },
  }) || {}),
});

onBeforeUnmount(() => {
  cancelRequested.value = true;
  void benchmarkClient?.cancelCurrentOperation();
  void benchmarkClient?.dispose();
  benchmarkClient = undefined;
});
</script>

<template>
  <div data-testid="hizofs-benchmark-panel" tw-class="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gray-50 dark:bg-gray-950">
    <div tw-class="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <div tw-class="mx-auto max-w-[1400px] space-y-4">
        <section tw-class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div tw-class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 tw-class="text-sm font-semibold text-gray-900 dark:text-gray-100">Filesystem benchmark</h3>
              <p tw-class="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">Runs isolated workloads in a Worker against a benchmark-only HizoFS and unencrypted raw OPFS. Normal Naidan storage is not used.</p>
            </div>
            <div tw-class="flex flex-wrap gap-2">
              <button type="button" data-testid="hizofs-benchmark-copy-config" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" :disabled="running" @click="copyConfiguration"><ClipboardIcon tw-class="mr-1 inline h-3.5 w-3.5" />Copy configuration JSON</button>
              <button type="button" data-testid="hizofs-benchmark-clean-data" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800" :disabled="running || cleaningData" @click="cleanBenchmarkData">{{ cleaningData ? 'Cleaning…' : 'Clean benchmark data' }}</button>
              <button type="button" data-testid="hizofs-benchmark-load-config" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" :disabled="running" @click="openConfigurationImport"><UploadIcon tw-class="mr-1 inline h-3.5 w-3.5" />Load configuration JSON</button>
            </div>
          </div>
        </section>

        <section tw-class="grid gap-4 lg:grid-cols-2">
          <div tw-class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <label tw-class="block text-[10px] font-semibold uppercase tracking-wide text-gray-500">Backends</label>
            <select data-testid="hizofs-benchmark-backend-mode" :value="configuration.backendMode" tw-class="mt-2 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="setBackendMode({ backendMode: ($event.target as HTMLSelectElement).value as HizoFSBenchmarkBackendMode })">
              <option value="compare">Compare HizoFS with raw OPFS</option>
              <option value="hizofs_only">HizoFS only</option>
              <option value="raw_opfs_only">Raw OPFS only</option>
            </select>
          </div>

          <div tw-class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <label tw-class="block text-[10px] font-semibold uppercase tracking-wide text-gray-500">Workload preset</label>
            <div tw-class="mt-2 grid grid-cols-4 gap-1">
              <button v-for="preset in (['quick', 'standard', 'stress', 'custom'] as const)" :key="preset" type="button" :data-testid="`hizofs-benchmark-preset-${preset}`" :tw-class="['rounded border px-2 py-2 text-xs capitalize', configuration.preset === preset ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800']" :disabled="running" @click="setPreset({ preset })">{{ preset }}</button>
            </div>
          </div>
        </section>

        <section tw-class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <label tw-class="block text-[10px] font-semibold uppercase tracking-wide text-gray-500">Run mode</label>
          <select v-model="runMode" data-testid="hizofs-benchmark-run-mode" tw-class="mt-2 w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-950" :disabled="running">
            <option value="single">Single benchmark configuration</option>
            <option value="policy_matrix">Policy matrix</option>
            <option value="large_write">Large sequential writes</option>
            <option value="lifecycle_matrix">Store lifecycle matrix</option>
            <option value="bulk_transaction">Bulk transaction comparison</option>
            <option value="garbage_collection_policy">Garbage-collection policy</option>
            <option value="diagnostics_overhead">Backing diagnostics overhead</option>
          </select>
          <p tw-class="mt-2 text-[10px] text-gray-500">Studies derive isolated configurations from the current values, run them sequentially, stop after cancellation or failure, and export one combined JSON report.</p>
        </section>

        <section v-if="configuration.preset === 'custom'" tw-class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div tw-class="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Workload packs</div>
          <div tw-class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <label v-for="workload in (['small_files', 'sequential_io', 'random_access', 'directory_operations', 'bulk_operations', 'hizofs_maintenance'] as const)" :key="workload" :tw-class="['flex items-center gap-2 rounded border px-3 py-2 text-xs', configuration.workloads.includes(workload) ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20' : 'border-gray-300 dark:border-gray-600', workload === 'hizofs_maintenance' && configuration.backendMode === 'raw_opfs_only' ? 'opacity-40' : '']">
              <input type="checkbox" :checked="configuration.workloads.includes(workload)" :disabled="running || (workload === 'hizofs_maintenance' && configuration.backendMode === 'raw_opfs_only')" @change="toggleWorkload({ workload })">
              <span>{{ workloadLabel({ workload }) }}</span>
            </label>
          </div>
        </section>

        <section tw-class="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <button type="button" data-testid="hizofs-benchmark-advanced-toggle" tw-class="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-medium" :disabled="running" @click="advancedOpen = !advancedOpen">
            <span>Advanced settings</span>
            <ChevronDownIcon :tw-class="['h-4 w-4 transition-transform', advancedOpen ? 'rotate-180' : '']" />
          </button>
          <div v-if="advancedOpen" tw-class="grid gap-4 border-t border-gray-200 p-4 sm:grid-cols-2 lg:grid-cols-4 dark:border-gray-700">
            <label tw-class="text-xs">Run label<input v-model="configuration.runLabel" type="text" maxlength="200" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" placeholder="Optional local label"></label>
            <label tw-class="text-xs">Warm-up iterations<select v-model.number="configuration.warmupIterations" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="0">0</option><option :value="1">1</option><option :value="2">2</option></select></label>
            <label tw-class="text-xs">Measured iterations<select v-model.number="configuration.measuredIterations" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1">1</option><option :value="3">3</option><option :value="5">5</option><option :value="10">10</option></select></label>
            <label tw-class="text-xs">Store lifecycle<select v-model="configuration.storeLifecycle" data-testid="hizofs-benchmark-store-lifecycle" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option value="reuse_without_gc">Reuse without GC</option><option value="fresh_per_iteration">Fresh store per iteration</option><option value="reuse_with_gc_between_iterations">Reuse with GC between iterations</option><option value="reopen_between_iterations">Reopen between iterations</option></select></label>
            <label tw-class="text-xs">Backing diagnostics<select v-model="configuration.backingStoreDiagnosticsMode" data-testid="hizofs-benchmark-backing-diagnostics-mode" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option value="basic">Basic totals</option><option value="detailed">Detailed path attribution</option></select></label>
            <label tw-class="text-xs">Chunk write concurrency<select v-model.number="configuration.hizoFSRuntimePolicy.fileChunkWriteConcurrency" data-testid="hizofs-benchmark-write-concurrency" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1">1</option><option :value="2">2</option><option :value="4">4</option><option :value="8">8</option><option :value="16">16</option></select></label>
            <label tw-class="text-xs">Sequential read prefetch<select v-model.number="configuration.hizoFSRuntimePolicy.fileChunkReadPrefetchConcurrency" data-testid="hizofs-benchmark-read-prefetch" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1">Off / 1</option><option :value="2">2</option><option :value="4">4</option><option :value="8">8</option><option :value="16">16</option></select></label>
            <label tw-class="text-xs">Backing file handles<select v-model.number="configuration.hizoFSRuntimePolicy.backingFileHandleCacheEntryLimit" data-testid="hizofs-benchmark-backing-file-handle-cache" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="0">Disabled</option><option :value="1024">1,024</option><option :value="4096">4,096</option><option :value="16384">16,384</option></select></label>
            <label tw-class="text-xs">File chunk cache<select v-model.number="configuration.hizoFSRuntimePolicy.fileChunkCacheByteLimit" data-testid="hizofs-benchmark-file-chunk-cache" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="0">Disabled</option><option :value="4194304">4 MiB</option><option :value="8388608">8 MiB</option><option :value="16842752">16 MiB + record overhead</option><option :value="33554432">32 MiB</option></select></label>
            <label tw-class="text-xs">Chunk cache admission<select v-model="configuration.hizoFSRuntimePolicy.fileChunkCacheAdmission" data-testid="hizofs-benchmark-file-chunk-cache-admission" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option value="read">Read only</option><option value="read_write">Read and write</option></select></label>
            <label tw-class="text-xs">Random seed<input v-model.number="configuration.randomSeed" type="number" min="1" max="4294967295" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @input="markCustom"></label>

            <label tw-class="text-xs">Small file count<select v-model.number="configuration.smallFiles.count" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="32">32</option><option :value="500">500</option><option :value="1000">1,000</option><option :value="10000">10,000</option></select></label>
            <label tw-class="text-xs">Small file size<select v-model.number="configuration.smallFiles.sizeBytes" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="4096">4 KiB</option><option :value="65536">64 KiB</option><option :value="1048576">1 MiB</option></select></label>
            <label tw-class="text-xs">Sequential file size<select v-model.number="configuration.sequentialIo.fileSizeBytes" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1048576">1 MiB</option><option :value="16777216">16 MiB</option><option :value="134217728">128 MiB</option><option :value="1073741824">1 GiB</option></select></label>
            <label tw-class="text-xs">Sequential block size<select v-model.number="configuration.sequentialIo.blockSizeBytes" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="65536">64 KiB</option><option :value="262144">256 KiB</option><option :value="524288">512 KiB</option><option :value="1048576">1 MiB</option></select></label>

            <label tw-class="text-xs">Random file size<select v-model.number="configuration.randomAccess.fileSizeBytes" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1048576">1 MiB</option><option :value="16777216">16 MiB</option><option :value="134217728">128 MiB</option><option :value="1073741824">1 GiB</option></select></label>
            <label tw-class="text-xs">Random operation count<select v-model.number="configuration.randomAccess.operationCount" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="32">32</option><option :value="500">500</option><option :value="5000">5,000</option><option :value="50000">50,000</option></select></label>
            <label tw-class="text-xs">Random block size<select v-model.number="configuration.randomAccess.blockSizeBytes" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="4096">4 KiB</option><option :value="65536">64 KiB</option><option :value="262144">256 KiB</option></select></label>
            <label tw-class="text-xs">Directory entry count<select v-model.number="configuration.directoryOperations.entryCount" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="64">64</option><option :value="1000">1,000</option><option :value="10000">10,000</option></select></label>

            <label tw-class="text-xs">Maintenance clone count<select v-model.number="configuration.hizoFSMaintenance.cloneCount" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="8">8</option><option :value="50">50</option><option :value="100">100</option><option :value="1000">1,000</option></select></label>
            <label tw-class="text-xs">Maintenance source size<select v-model.number="configuration.hizoFSMaintenance.sourceFileSizeBytes" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1048576">1 MiB</option><option :value="16777216">16 MiB</option><option :value="67108864">64 MiB</option><option :value="134217728">128 MiB</option></select></label>
            <label tw-class="text-xs">GC remove concurrency<select v-model.number="configuration.hizoFSMaintenance.garbageCollectionSweep.removeConcurrency" data-testid="hizofs-benchmark-gc-remove-concurrency" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="1">1</option><option :value="2">2</option><option :value="4">4</option><option :value="8">8</option><option :value="16">16</option></select></label>
            <label tw-class="text-xs">GC removals per slice<select v-model.number="configuration.hizoFSMaintenance.garbageCollectionSweep.maximumRemovalsPerSlice" data-testid="hizofs-benchmark-gc-slice-removals" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="16">16</option><option :value="32">32</option><option :value="64">64</option><option :value="128">128</option><option :value="256">256</option></select></label>
            <label tw-class="text-xs">GC soft slice budget<select v-model.number="configuration.hizoFSMaintenance.garbageCollectionSweep.maximumSliceDurationMs" data-testid="hizofs-benchmark-gc-slice-duration" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running" @change="markCustom"><option :value="50">50 ms</option><option :value="100">100 ms</option><option :value="150">150 ms</option><option :value="250">250 ms</option><option :value="500">500 ms</option></select></label>
            <label tw-class="text-xs">Benchmark data<select v-model="configuration.benchmarkDataRetention" tw-class="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 dark:border-gray-600 dark:bg-gray-950" :disabled="running"><option value="delete_after_run">Delete after run</option><option value="keep_after_run">Keep for raw inspection</option></select></label>
            <p tw-class="text-[10px] text-gray-500 sm:col-span-2 lg:col-span-4">Lifecycle events separate fresh-store cost, orphan accumulation, GC effects, and reopen cost. Runtime tuning is benchmark-only and does not change the normal HizoFS defaults. Phase durations are nested and must not be added together. Reported harness memory covers benchmark-owned buffers only. HizoFS resource gauges separately report owned dirty, pending-write, and prefetch plaintext; neither measurement is a complete browser heap measurement.</p>
          </div>
        </section>

        <section tw-class="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div tw-class="grid gap-2 text-xs sm:grid-cols-6">
            <div><span tw-class="text-gray-500">Run mode:</span> {{ runMode }}</div>
            <div><span tw-class="text-gray-500">Backends:</span> {{ configuration.backendMode }}</div>
            <div><span tw-class="text-gray-500">Workloads:</span> {{ selectedWorkloadLabels }}</div>
            <div><span tw-class="text-gray-500">Lifecycle:</span> {{ configuration.storeLifecycle }}</div>
            <div><span tw-class="text-gray-500">Diagnostics:</span> {{ configuration.backingStoreDiagnosticsMode }}</div>
            <div><span tw-class="text-gray-500">Estimated logical writes:</span> {{ formatBytes({ value: estimatedWrittenBytes }) }}</div>
          </div>
          <div tw-class="mt-4 flex flex-wrap items-center gap-2">
            <button v-if="!running" type="button" data-testid="hizofs-benchmark-run" tw-class="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700" @click="runBenchmark"><PlayIcon tw-class="mr-1 inline h-4 w-4" />{{ runMode === 'single' ? 'Run benchmark' : 'Run benchmark study' }}</button>
            <button v-else type="button" data-testid="hizofs-benchmark-cancel" tw-class="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" :disabled="cancelling" @click="cancelBenchmark"><SquareIcon tw-class="mr-1 inline h-4 w-4" />{{ cancelling ? 'Cancelling…' : 'Cancel' }}</button>
            <span v-if="copyStatus" tw-class="text-xs text-emerald-600 dark:text-emerald-400">{{ copyStatus }}</span>
          </div>
          <div v-if="progress" tw-class="mt-4">
            <div v-if="studyVariantProgress" tw-class="mb-1 text-xs font-medium text-gray-600 dark:text-gray-300">Variant {{ studyVariantProgress.index }} / {{ studyVariantProgress.total }}: {{ studyVariantProgress.label }}</div>
            <div tw-class="flex justify-between text-xs text-gray-500"><span>{{ progress.message }}</span><span>{{ progress.completedUnits }} / {{ progress.totalUnits }}</span></div>
            <div tw-class="mt-1 h-2 overflow-hidden rounded bg-gray-200 dark:bg-gray-700"><div tw-class="h-full bg-emerald-500 transition-[width]" :style="{ width: `${String(progressPercent)}%` }" /></div>
          </div>
          <div v-if="errorMessage" tw-class="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ errorMessage }}</div>
        </section>

        <section v-if="studyReport" data-testid="hizofs-benchmark-study-report" tw-class="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <header tw-class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
            <div><h3 tw-class="text-sm font-semibold">Study result: {{ studyReport.status }}</h3><div tw-class="mt-1 font-mono text-[10px] text-gray-500">{{ studyReport.studyKind }} · {{ studyReport.studyId }}</div></div>
            <div tw-class="flex flex-wrap gap-2">
              <button type="button" data-testid="hizofs-benchmark-copy-summary" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="copySummaryJson">Copy summary JSON</button>
              <button type="button" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="copyHumanSummary">Copy Markdown summary</button>
              <button type="button" data-testid="hizofs-benchmark-download-full" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="downloadFullJson"><DownloadIcon tw-class="mr-1 inline h-3.5 w-3.5" />Download full JSON</button>
            </div>
          </header>
          <div tw-class="border-b border-gray-200 px-4 py-2 text-[10px] text-gray-500 dark:border-gray-700">Completed {{ studyReport.completedVariantCount }} of {{ studyReport.plannedVariantCount }} planned variants. Each variant owns an isolated benchmark run and full diagnostics.</div>
          <div tw-class="overflow-x-auto">
            <table tw-class="w-full min-w-[1100px] text-left text-xs">
              <thead tw-class="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-950"><tr><th tw-class="px-3 py-2">Variant</th><th tw-class="px-3 py-2">Status</th><th tw-class="px-3 py-2">Configuration</th><th tw-class="px-3 py-2">Case</th><th tw-class="px-3 py-2 text-right">Raw median</th><th tw-class="px-3 py-2 text-right">HizoFS median</th><th tw-class="px-3 py-2 text-right">Ratio</th></tr></thead>
              <tbody>
                <tr v-for="row in studyResultRows" :key="row.key" tw-class="border-t border-gray-100 align-top dark:border-gray-800">
                  <td tw-class="px-3 py-2 font-medium">{{ row.variantLabel }}</td>
                  <td tw-class="px-3 py-2 font-mono">{{ row.status }}</td>
                  <td tw-class="max-w-[360px] px-3 py-2 font-mono text-[9px] text-gray-500">{{ row.configurationSummary }}</td>
                  <td tw-class="px-3 py-2">{{ row.caseLabel }}</td>
                  <td tw-class="px-3 py-2 text-right font-mono">{{ formatDuration({ value: row.rawMedian }) }}</td>
                  <td tw-class="px-3 py-2 text-right font-mono">{{ formatDuration({ value: row.hizoFSMedian }) }}</td>
                  <td tw-class="px-3 py-2 text-right font-mono">{{ row.durationRatio === undefined ? '—' : `${row.durationRatio.toFixed(2)}×` }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="report" data-testid="hizofs-benchmark-report" tw-class="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <header tw-class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
            <div><h3 tw-class="text-sm font-semibold">Result: {{ report.status }}</h3><div tw-class="mt-1 font-mono text-[10px] text-gray-500">{{ report.runId }}</div></div>
            <div tw-class="flex flex-wrap gap-2">
              <button type="button" data-testid="hizofs-benchmark-copy-summary" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="copySummaryJson">Copy summary JSON</button>
              <button type="button" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="copyHumanSummary">Copy Markdown summary</button>
              <button type="button" data-testid="hizofs-benchmark-download-full" tw-class="rounded border border-gray-300 px-2.5 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-800" @click="downloadFullJson"><DownloadIcon tw-class="mr-1 inline h-3.5 w-3.5" />Download full JSON</button>
            </div>
          </header>
          <div tw-class="border-b border-gray-200 px-4 py-2 text-[10px] text-gray-500 dark:border-gray-700">Duration ratio is HizoFS median duration divided by raw OPFS median duration.</div>
          <div tw-class="overflow-x-auto">
            <table tw-class="w-full min-w-[1100px] text-left text-xs">
              <thead tw-class="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 dark:bg-gray-950"><tr><th tw-class="px-3 py-2">Case</th><th tw-class="px-3 py-2">Raw median</th><th tw-class="px-3 py-2">HizoFS median</th><th tw-class="px-3 py-2">Duration ratio</th><th tw-class="px-3 py-2">Raw rate</th><th tw-class="px-3 py-2">HizoFS rate</th><th tw-class="px-3 py-2">Read amp</th><th tw-class="px-3 py-2">Write amp</th><th tw-class="px-3 py-2">HizoFS commits</th></tr></thead>
              <tbody>
                <template v-for="result in report.results" :key="`${result.workload}:${result.caseId}`">
                  <tr tw-class="border-t border-gray-100 dark:border-gray-800"><td tw-class="px-3 py-2"><div tw-class="font-medium">{{ result.label }}</div><div tw-class="font-mono text-[9px] text-gray-400">{{ result.caseId }}</div></td><td tw-class="px-3 py-2 font-mono">{{ formatDuration({ value: result.backends.rawOpfs?.durationMs.median }) }}</td><td tw-class="px-3 py-2 font-mono">{{ formatDuration({ value: result.backends.hizofs?.durationMs.median }) }}</td><td tw-class="px-3 py-2 font-mono">{{ result.comparison?.durationRatio === undefined ? '—' : `${result.comparison.durationRatio.toFixed(2)}×` }}</td><td tw-class="px-3 py-2 font-mono">{{ formatRate({ result: result.backends.rawOpfs }) }}</td><td tw-class="px-3 py-2 font-mono">{{ formatRate({ result: result.backends.hizofs }) }}</td><td tw-class="px-3 py-2 font-mono">{{ result.backends.hizofs?.hizoFSDiagnosticsTotals?.amplification.backingReadBytesPerLogicalByte?.toFixed(2) ?? '—' }}</td><td tw-class="px-3 py-2 font-mono">{{ result.backends.hizofs?.hizoFSDiagnosticsTotals?.amplification.backingWriteBytesPerLogicalByte?.toFixed(2) ?? '—' }}</td><td tw-class="px-3 py-2 font-mono">{{ result.backends.hizofs?.hizoFSDiagnosticsTotals?.commits.superblockPublications ?? '—' }}</td></tr>
                  <tr tw-class="border-t border-dashed border-gray-100 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-950/40"><td colspan="9" tw-class="px-3 py-2"><details><summary tw-class="cursor-pointer text-[10px] text-gray-500">Parameters and samples</summary><pre tw-class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px]">{{ JSON.stringify(result, undefined, 2) }}</pre></details></td></tr>
                </template>
              </tbody>
            </table>
          </div>
          <details v-if="report.lifecycleEvents.length > 0" tw-class="border-t border-gray-200 p-3 dark:border-gray-700"><summary tw-class="cursor-pointer text-xs text-gray-500">Store lifecycle events</summary><pre tw-class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px]">{{ JSON.stringify(report.lifecycleEvents, undefined, 2) }}</pre></details>
          <div v-if="report.failure" tw-class="border-t border-red-200 bg-red-50 p-3 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ report.failure.errorName }}: {{ report.failure.errorMessage }}</div>
          <div v-if="report.cleanup.remainingPaths.length > 0" tw-class="border-t border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">Benchmark data remains at <span tw-class="font-mono">{{ report.cleanup.remainingPaths.join(', ') }}</span>.</div>
        </section>
      </div>
    </div>

    <div v-if="configurationImportOpen" tw-class="absolute inset-0 z-10 flex items-center justify-center bg-black/45 p-4">
      <section tw-class="flex max-h-[85%] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <header tw-class="border-b border-gray-200 px-4 py-3 text-sm font-semibold dark:border-gray-700">Load benchmark configuration JSON</header>
        <textarea v-model="configurationImportText" data-testid="hizofs-benchmark-config-json-input" tw-class="min-h-0 flex-1 resize-none bg-gray-950 p-3 font-mono text-xs text-gray-100" spellcheck="false" />
        <div v-if="configurationImportError" tw-class="border-t border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ configurationImportError }}</div>
        <footer tw-class="flex justify-end gap-2 border-t border-gray-200 p-3 dark:border-gray-700"><button type="button" tw-class="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600" @click="configurationImportOpen = false">Cancel</button><button type="button" data-testid="hizofs-benchmark-apply-config" tw-class="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white" @click="applyConfigurationImport">Apply</button></footer>
      </section>
    </div>
  </div>
</template>
