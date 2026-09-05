<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRaw } from 'vue';
import { AlertCircleIcon, CheckCircle2Icon, DownloadCloudIcon, DownloadIcon, Loader2Icon, ShieldCheckIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { collectDownloadVerificationEvidence } from '@/features/transformers-js/download-verification/logic/collect-download-verification-evidence';
import type { DownloadVerificationCachedRevisionInventory } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import { createModelSupportInvestigationEvidenceWorkerClient } from '@/features/transformers-js/model-support-investigation/evidence-worker/client-hosted';
import type {
  DownloadVerificationModelArtifactRequestObservation,
  DownloadVerificationRun,
} from '@/features/transformers-js/download-verification/types';

const emit = defineEmits<{
  (e: 'close'): void,
}>();

const modelId = ref('');
const isRunning = ref(false);
const run = ref<DownloadVerificationRun | undefined>(undefined);
const error = ref<string | undefined>(undefined);
const modelArtifactObservations = ref<DownloadVerificationModelArtifactRequestObservation[]>([]);
const modelArtifactObservationError = ref<string | undefined>(undefined);
const cacheInventory = ref<DownloadVerificationCachedRevisionInventory | undefined>(undefined);
const cacheInspectionError = ref<string | undefined>(undefined);
const evidenceRunId = ref<string | undefined>(undefined);
const evidenceExporting = ref(false);
const evidenceExportError = ref<string | undefined>(undefined);
const modalContent = ref<HTMLElement | undefined>(undefined);
let previouslyFocusedElement: HTMLElement | undefined;
let previousBodyOverflow = '';
let runAbortController: AbortController | undefined;
let activeEvidenceClient: ReturnType<typeof createModelSupportInvestigationEvidenceWorkerClient> | undefined;

const canRun = computed(() => modelId.value.trim().length > 0 && !isRunning.value);
const successfulObservationCount = computed(() => (
  run.value?.transportObservations.filter(observation => observation.error === undefined).length ?? 0
));
const failedObservationCount = computed(() => (
  run.value?.transportObservations.filter(observation => observation.error !== undefined).length ?? 0
));


function getFocusableElements(): HTMLElement[] {
  const root = modalContent.value;
  if (root === undefined) return [];

  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => element.offsetParent !== null);
}

function handleModalKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusableElements = getFocusableElements();
  if (focusableElements.length === 0) {
    event.preventDefault();
    modalContent.value?.focus();
    return;
  }

  const first = focusableElements[0];
  const last = focusableElements.at(-1);
  if (first === undefined || last === undefined) return;

  if (event.shiftKey && (document.activeElement === first || document.activeElement === modalContent.value)) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function formatBytes({ bytes }: { bytes: number }): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

async function startVerification() {
  if (!canRun.value) return;
  runAbortController?.abort();
  const controller = new AbortController();
  runAbortController = controller;
  isRunning.value = true;
  error.value = undefined;
  modelArtifactObservationError.value = undefined;
  modelArtifactObservations.value = [];
  cacheInventory.value = undefined;
  cacheInspectionError.value = undefined;
  const runId = crypto.randomUUID();
  evidenceRunId.value = runId;
  evidenceExportError.value = undefined;
  run.value = undefined;
  try {
    const evidence = await collectDownloadVerificationEvidence({
      modelId: modelId.value,
      runId,
      signal: controller.signal,
    });
    run.value = evidence.run;
    modelArtifactObservations.value = evidence.modelArtifactObservations;
    modelArtifactObservationError.value = evidence.modelArtifactObservationError;
    cacheInventory.value = evidence.cacheBefore;
    cacheInspectionError.value = evidence.cacheInspectionError;
  } catch (runError) {
    if (!controller.signal.aborted) {
      error.value = runError instanceof Error ? runError.message : String(runError);
    }
  } finally {
    if (runAbortController === controller) runAbortController = undefined;
    isRunning.value = false;
  }
}

async function downloadEvidence() {
  if (run.value === undefined || evidenceRunId.value === undefined || evidenceExporting.value) return;
  evidenceExporting.value = true;
  evidenceExportError.value = undefined;
  let evidenceClient: ReturnType<typeof createModelSupportInvestigationEvidenceWorkerClient> | undefined;
  try {
    evidenceClient = createModelSupportInvestigationEvidenceWorkerClient();
    activeEvidenceClient = evidenceClient;
    const { blob, fileName } = await evidenceClient.createDownloadVerificationEvidence({
      evidence: {
        schemaVersion: 1,
        runId: evidenceRunId.value,
        mode: 'probe-only',
        run: structuredClone(toRaw(run.value)),
        modelArtifactObservations: structuredClone(toRaw(modelArtifactObservations.value)),
        modelArtifactObservationError: modelArtifactObservationError.value,
        cacheBefore: cacheInventory.value === undefined ? undefined : structuredClone(toRaw(cacheInventory.value)),
        cacheInspectionError: cacheInspectionError.value,
      },
    });
    // The Worker operation can resolve in the same turn that the modal is unmounted.
    // In that race, disposal can no longer reject the already-settled Promise, so the
    // host must re-check that this export still belongs to the live modal before it
    // creates a Blob URL or clicks the download anchor.
    if (activeEvidenceClient !== evidenceClient) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.append(anchor);
    try {
      anchor.click();
    } finally {
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  } catch (exportError) {
    evidenceExportError.value = exportError instanceof Error ? exportError.message : String(exportError);
  } finally {
    if (evidenceClient !== undefined && activeEvidenceClient === evidenceClient) {
      activeEvidenceClient = undefined;
      await evidenceClient.dispose();
    }
    evidenceExporting.value = false;
  }
}

function close() {
  runAbortController?.abort();
  runAbortController = undefined;
  emit('close');
}

onMounted(async () => {
  previouslyFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  modalContent.value?.focus();
});

onUnmounted(() => {
  runAbortController?.abort();
  runAbortController = undefined;
  const evidenceClient = activeEvidenceClient;
  activeEvidenceClient = undefined;
  void evidenceClient?.dispose();
  document.body.style.overflow = previousBodyOverflow;
  previouslyFocusedElement?.focus();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      formatBytes,
      startVerification,
      downloadEvidence,
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div
      data-testid="download-verification-modal"
      tw-class="fixed inset-0 z-[210] flex items-center justify-center overscroll-contain bg-black/50 p-4 backdrop-blur-[2px]"
      @keydown="handleModalKeydown({ event: $event })"
    >
      <div
        ref="modalContent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-verification-title"
        tabindex="-1"
        tw-class="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl outline-none dark:border-gray-800 dark:bg-gray-950"
      >
        <header tw-class="flex shrink-0 items-center justify-between gap-4 border-b border-gray-100 bg-gray-50/80 px-5 py-4 dark:border-gray-800 dark:bg-gray-900/70">
          <div tw-class="min-w-0">
            <div tw-class="flex items-center gap-2">
              <DownloadCloudIcon tw-class="h-5 w-5 shrink-0 text-purple-500" />
              <h2 id="download-verification-title" tw-class="truncate text-base font-bold text-gray-900 dark:text-white">
                {{ lazyStrings.DownloadVerificationModal__download_verification() }}
              </h2>
            </div>
            <p tw-class="mt-1 text-[11px] font-medium leading-relaxed text-gray-500 dark:text-gray-400">
              {{ lazyStrings.DownloadVerificationModal__large_model_files_are_never_downloaded_in_full() }}
            </p>
          </div>
          <button
            type="button"
            data-testid="download-verification-close"
            tw-class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            :aria-label="lazyStrings.DownloadVerificationModal__close()"
            @click="close"
          >
            <XIcon tw-class="h-4 w-4" />
          </button>
        </header>

        <div tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
          <section tw-class="space-y-4">
            <div tw-class="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <label tw-class="block">
                <span tw-class="mb-1.5 block text-xs font-bold text-gray-600 dark:text-gray-300">
                  {{ lazyStrings.DownloadVerificationModal__model_id_or_hugging_face_url() }}
                </span>
                <input
                  v-model="modelId"
                  data-testid="download-verification-model-id"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="HuggingFaceTB/SmolLM2-135M-Instruct"
                  tw-class="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 font-mono text-xs text-gray-900 outline-none transition-all focus:border-purple-400 focus:ring-4 focus:ring-purple-500/10 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  @keydown.enter="startVerification"
                />
              </label>
              <button
                type="button"
                data-testid="download-verification-run"
                :disabled="!canRun"
                tw-class="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-purple-600 px-5 py-3 text-xs font-bold text-white shadow-sm transition-all hover:bg-purple-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                @click="startVerification"
              >
                <Loader2Icon v-if="isRunning" tw-class="h-4 w-4 animate-spin" />
                <ShieldCheckIcon v-else tw-class="h-4 w-4" />
                {{ lazyStrings.DownloadVerificationModal__run_verification() }}
              </button>
            </div>

            <div tw-class="grid gap-3 sm:grid-cols-2">
              <div tw-class="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                  {{ lazyStrings.DownloadVerificationModal__full_model_download() }}
                </p>
                <p tw-class="mt-1 text-sm font-bold text-emerald-800 dark:text-emerald-300">
                  {{ lazyStrings.DownloadVerificationModal__disabled() }}
                </p>
              </div>
              <div tw-class="rounded-xl border border-blue-200 bg-blue-50/70 p-3 dark:border-blue-900/60 dark:bg-blue-950/30">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                  {{ lazyStrings.DownloadVerificationModal__probe_byte_budget() }}
                </p>
                <p tw-class="mt-1 text-sm font-bold text-blue-800 dark:text-blue-300">2 MiB</p>
              </div>
            </div>

            <p tw-class="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-[11px] font-medium leading-relaxed text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
              {{ lazyStrings.DownloadVerificationModal__public_models_only_credentials_are_omitted_and_probe_data_is_not_saved_to_the_model_cache() }}
            </p>
          </section>

          <section v-if="error" data-testid="download-verification-error" tw-class="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30">
            <div tw-class="flex items-start gap-2">
              <AlertCircleIcon tw-class="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <div tw-class="min-w-0">
                <p tw-class="text-xs font-bold text-red-700 dark:text-red-300">{{ lazyStrings.DownloadVerificationModal__verification_failed() }}</p>
                <p tw-class="mt-1 break-words font-mono text-[10px] text-red-600 dark:text-red-400">{{ error }}</p>
              </div>
            </div>
          </section>

          <section v-if="run" data-testid="download-verification-results" tw-class="mt-5 space-y-4">
            <div data-testid="download-verification-probe-only-scope" tw-class="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] font-medium leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertCircleIcon tw-class="mt-0.5 h-4 w-4 shrink-0" />
              <p>{{ lazyStrings.DownloadVerificationModal__probe_only_evidence_description() }}</p>
            </div>

            <div tw-class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div tw-class="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{{ lazyStrings.DownloadVerificationModal__repository_files() }}</p>
                <p tw-class="mt-1 text-lg font-bold text-gray-800 dark:text-gray-200">{{ run.repositoryFileCount }}</p>
              </div>
              <div tw-class="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{{ lazyStrings.DownloadVerificationModal__transport_probes() }}</p>
                <p tw-class="mt-1 text-lg font-bold text-gray-800 dark:text-gray-200">{{ successfulObservationCount }} / {{ run.transportObservations.length }}</p>
                <p v-if="failedObservationCount > 0" tw-class="mt-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400">{{ failedObservationCount }} failed</p>
              </div>
              <div tw-class="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{{ lazyStrings.DownloadVerificationModal__production_model_artifact_requests() }}</p>
                <p tw-class="mt-1 text-lg font-bold text-gray-800 dark:text-gray-200">{{ modelArtifactObservations.filter(observation => observation.status === 'observed').length }} / {{ modelArtifactObservations.length }}</p>
              </div>
              <div tw-class="rounded-xl border border-gray-200 p-3 dark:border-gray-800">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{{ lazyStrings.DownloadVerificationModal__network_payload_consumed() }}</p>
                <p tw-class="mt-1 text-lg font-bold text-gray-800 dark:text-gray-200">{{ formatBytes({ bytes: run.bytesConsumed }) }}</p>
                <p tw-class="mt-0.5 text-[10px] font-medium text-gray-400">/ {{ formatBytes({ bytes: run.maximumBytes }) }}</p>
              </div>
            </div>

            <div tw-class="flex flex-col gap-2 rounded-xl border border-purple-200 bg-purple-50/60 p-3 dark:border-purple-900/60 dark:bg-purple-950/20 sm:flex-row sm:items-center sm:justify-between">
              <div tw-class="min-w-0">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-purple-600 dark:text-purple-400">{{ lazyStrings.DownloadVerificationModal__evidence() }}</p>
                <p tw-class="mt-1 text-[10px] font-medium leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.DownloadVerificationModal__probe_only_evidence_description() }}</p>
                <p v-if="evidenceExportError" data-testid="download-verification-evidence-error" tw-class="mt-1 break-words font-mono text-[9px] text-red-600 dark:text-red-400">{{ evidenceExportError }}</p>
              </div>
              <button
                type="button"
                data-testid="download-verification-evidence-download"
                :disabled="evidenceExporting"
                tw-class="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-purple-200 bg-white px-4 py-2.5 text-xs font-bold text-purple-700 shadow-sm transition-all hover:bg-purple-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-purple-900 dark:bg-gray-900 dark:text-purple-300 dark:hover:bg-purple-950/40"
                @click="downloadEvidence"
              >
                <Loader2Icon v-if="evidenceExporting" tw-class="h-4 w-4 animate-spin" />
                <DownloadIcon v-else tw-class="h-4 w-4" />
                {{ lazyStrings.DownloadVerificationModal__download_evidence() }}
              </button>
            </div>

            <div data-testid="download-verification-model-artifact-requests" tw-class="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
              <div tw-class="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                <p tw-class="text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{{ lazyStrings.DownloadVerificationModal__production_model_artifact_requests() }}</p>
              </div>
              <p v-if="modelArtifactObservationError" tw-class="px-4 py-3 font-mono text-[10px] text-red-600 dark:text-red-400">{{ modelArtifactObservationError }}</p>
              <div v-if="modelArtifactObservations.length > 0" tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                <div v-for="observation in modelArtifactObservations" :key="`${observation.candidate.device}-${observation.candidate.dtype}`" tw-class="px-4 py-3">
                  <div tw-class="flex flex-wrap items-center gap-2 text-[10px] font-bold text-gray-600 dark:text-gray-300">
                    <span>{{ observation.candidate.device }}/{{ observation.candidate.dtype }}</span>
                    <span tw-class="font-mono text-[9px] text-gray-400">{{ observation.autoClass }}</span>
                    <span :class="observation.status === 'observed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'">{{ observation.status }}</span>
                  </div>
                  <p v-if="observation.error" tw-class="mt-1 break-words font-mono text-[9px] text-amber-600 dark:text-amber-400">{{ observation.error.name }}: {{ observation.error.message }}</p>
                  <div v-if="observation.paths.length > 0" tw-class="mt-2 space-y-1">
                    <p v-for="path in observation.paths" :key="path" tw-class="truncate font-mono text-[9px] text-gray-500 dark:text-gray-400">{{ path }}</p>
                  </div>
                </div>
              </div>
            </div>

            <div tw-class="rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
              <div tw-class="border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                <div tw-class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div tw-class="flex items-center gap-1.5 text-xs font-bold text-gray-800 dark:text-gray-200">
                    <CheckCircle2Icon tw-class="h-4 w-4 text-emerald-500" />
                    {{ run.normalizedModelId }}
                  </div>
                  <span tw-class="font-mono text-[9px] text-gray-400">{{ run.resolvedRevision }}</span>
                </div>
              </div>

              <div v-if="run.transportObservations.length > 0" tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                <div
                  v-for="observation in run.transportObservations"
                  :key="`${observation.path}-${observation.method}`"
                  tw-class="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
                >
                  <div tw-class="min-w-0">
                    <p tw-class="truncate font-mono text-[10px] font-semibold text-gray-700 dark:text-gray-300">{{ observation.path }}</p>
                    <p tw-class="mt-1 truncate text-[9px] font-medium text-gray-400">
                      {{ observation.method }} · {{ observation.status ?? 'error' }} · {{ observation.finalOrigin ?? observation.error?.name ?? 'unavailable' }}
                    </p>
                  </div>
                  <div tw-class="flex items-center gap-2 text-[9px] font-bold text-gray-500 dark:text-gray-400">
                    <span>{{ formatBytes({ bytes: observation.bytesConsumed }) }}</span>
                    <span v-if="observation.rangeHonored === true" tw-class="rounded-md bg-emerald-50 px-1.5 py-0.5 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">Range</span>
                    <span v-if="observation.abortedByByteBudget" tw-class="rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">Budget stop</span>
                  </div>
                </div>
              </div>
              <p v-else tw-class="px-4 py-5 text-center text-xs font-medium text-gray-400">
                {{ lazyStrings.DownloadVerificationModal__no_model_artifacts_were_probed() }}
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>
