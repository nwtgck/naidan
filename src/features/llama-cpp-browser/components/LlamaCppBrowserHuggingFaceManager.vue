<script setup lang="ts">
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';
import LlamaCppBrowserDownloadPlanFiles from './LlamaCppBrowserDownloadPlanFiles.vue';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { variantLabel } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { artifactRole } from '@/features/llama-cpp-browser/hugging-face/artifact-role';
import LlamaCppBrowserDeletionDialog from './LlamaCppBrowserDeletionDialog.vue';
import { useModelDeletionConfirm } from './useModelDeletionConfirm';
import { computed, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { AlertCircleIcon, ChevronDownIcon, DownloadIcon, ExternalLinkIcon, HardDriveIcon, Loader2Icon, PauseIcon, PlayIcon, SearchIcon, Trash2Icon } from 'lucide-vue-next';
import { quantizationChoices, preferredProjector, projectorChoices } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { lazyStrings } from '@/strings';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { cancelDownload } from '@/features/llama-cpp-browser/hugging-face/download';
import { installedSelection, listPendingDownloads } from '@/features/llama-cpp-browser/hugging-face/storage';
import { repositoryUrlPath, type DownloadConflict, type DownloadJournal, type DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';

import { useHuggingFaceSession } from '@/features/llama-cpp-browser/hugging-face/session';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { ModelPreset } from '@/features/llama-cpp-browser/model-preset';
const props = defineProps<{ disabled: boolean, modelPreset?: ModelPreset }>();
const emit = defineEmits<{ changed: [], busy: [value: boolean], modelReady: [model: LocalModel], selectionChanged: [] }>();
const { request: deletionRequest, finish: finishDeletion, confirmRemoval } = useModelDeletionConfirm();
const { input, checkedInput, catalog, requestedVariantUnresolved, quantization, candidate, projector, multimodal } = useHuggingFaceSession();
const id = useId(); const details = ref<HTMLDetailsElement>(); const active = ref<AbortController>();
let inspectionPreset: ModelPreset | undefined;
let inspecting = false;
const queue = getDownloadQueue();
const repositoryJobs = computed(() => queue.jobs.value.filter(job => job.source === 'repository' && job.status !== 'complete' && job.status !== 'cancelled'));
const queuedDownloadBusy = computed(() => queue.jobs.value.some(job => jobIsBusy({ job })));
const error = ref<DownloadConflict | 'failed' | 'changed'>(); const pending = shallowRef<DownloadJournal[]>([]);
const errorMessage = computed(() => {
  switch (error.value) {
  case 'projector-conflict': return lazyStrings.LlamaCppBrowserHuggingFaceManager__shared_multimodal_file_conflict();
  case 'existing-files': return lazyStrings.LlamaCppBrowserHuggingFaceManager__model_files_already_exist();
  case 'different-download': return lazyStrings.LlamaCppBrowserHuggingFaceManager__another_download_already_exists();
  case 'changed': return lazyStrings.llamaCppBrowser__files_changed_review_before_deleting();
  case 'failed': return lazyStrings.LlamaCppBrowserHuggingFaceManager__download_failed_retry_or_resume();
  case undefined: return undefined;
  default: { const exhaustive: never = error.value; throw new Error(String(exhaustive)); }
  }
});
// A started journal may also be represented by a session job. Render it only
// once, and never offer deletion while its writer is active in another row.
const visiblePending = computed(() => pending.value.filter(pendingJob => !queue.jobs.value.some(job => job.repository === pendingJob.selection.repository && (jobIsBusy({ job }) || repositoryJobs.value.includes(job)))));
const catalogCurrent = computed(() => input.value.trim() === checkedInput.value);
const choices = computed(() => {
  const options = quantizationChoices({ repository: catalog.value?.repository ?? '', models: catalog.value?.models ?? [] });
  return options.map(option => ({ ...option, displayLabel: options.filter(other => other.label === option.label).length > 1 ? `${option.label} (${option.id})` : option.label }));
});
const selectedChoice = computed(() => choices.value.find(choice => choice.id === quantization.value));
const selected = computed(() => {
  const variants = selectedChoice.value?.models ?? [];
  return variants.find(model => model.label === candidate.value) ?? (variants.length === 1 ? variants[0] : undefined);
});
const projectorOptions = computed(() => projectorChoices({ files: catalog.value?.projectors ?? [] }));
const selectedProjector = computed(() => {
  switch (multimodal.value) {
  case 'off': return undefined; case 'on': break; default: { const exhaustive: never = multimodal.value; throw new Error(String(exhaustive)); }
  }
  const files = catalog.value?.projectors ?? [];
  return files.find(file => file.path === projector.value) ?? preferredProjector({ files });
});
const selectedChoiceLabel = computed(() => selectedChoice.value?.displayLabel ?? lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_model_files());
const selectedProjectorLabel = computed(() => projectorOptions.value.find(option => option.file.path === selectedProjector.value?.path)?.label ?? lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_companion_file());
const needsVariant = computed(() => selectedChoice.value !== undefined && selected.value === undefined);
const needsProjector = computed(() => multimodal.value === 'on' && selectedProjector.value === undefined);
const selectedFiles = computed(() => [...(selected.value?.files ?? []), ...(selectedProjector.value ? [selectedProjector.value] : [])]);
const selectionToCheck = computed<DownloadSelection | undefined>(() => {
  const current = catalog.value;
  return current && selected.value && !needsProjector.value && catalogCurrent.value ? { repository: current.repository, revision: current.revision, files: selectedFiles.value } : undefined;
});
const localAvailability = ref<'checking' | 'missing' | 'installed' | 'unavailable'>('missing');
const localCheckVersion = ref(0);
const downloadLabel = computed(() => {
  switch (localAvailability.value) {
  case 'checking': return lazyStrings.LlamaCppBrowserHuggingFaceManager__checking_model();
  case 'installed': return lazyStrings.LlamaCppBrowserHuggingFaceManager__downloaded();
  case 'missing': case 'unavailable': return lazyStrings.LlamaCppBrowserHuggingFaceManager__download();
  default: { const exhaustive: never = localAvailability.value; throw new Error(String(exhaustive)); }
  }
});
let lastAnnouncedSelection: string | undefined;
function recheckLocalFiles(): void {
  localCheckVersion.value++;
}
const total = computed(() => selectedFiles.value.reduce((sum, file) => sum + file.size, 0));
let disposed = false; const deleting = ref(false);
function percentage({ completed, total }: { completed: number, total: number }): number {
  return Math.min(100, Math.max(0, Math.floor(completed / total * 100)));
}
function size({ bytes }: { bytes: number }): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
async function refresh(): Promise<void> {
  if (props.disabled || disposed) return;
  try {
    pending.value = await listPendingDownloads();
  } catch {
    error.value ??= 'failed';
  }
}
async function inspect(): Promise<void> {
  if (active.value || props.disabled || deleting.value) return;
  inspecting = true;
  const controller = new AbortController(); active.value = controller; error.value = undefined;
  try {
    const submittedInput = input.value.trim();
    const { requestedVariant } = parseRepository({ input: submittedInput });
    const previousCandidate = selected.value?.label; const previousProjector = selectedProjector.value?.path ?? projector.value;
    const next = await getMetadataSession().inspect({ input: submittedInput, signal: controller.signal, freshness: 'refresh' });
    if (controller.signal.aborted || disposed) return;
    const sameRepository = next.repository === catalog.value?.repository;
    const nextChoices = quantizationChoices({ repository: next.repository, models: next.models });
    requestedVariantUnresolved.value = false;
    if (requestedVariant !== undefined) {
      // Keep legacy URL/storage variant names compatible with the new
      // quantization-first presentation. Never select a drafter by its quant alone.
      const exact = nextChoices.filter(choice => choice.label === requestedVariant || variantLabel({ repository: next.repository, path: choice.id }) === requestedVariant);
      const matches = exact.length ? exact : nextChoices.filter(choice => choice.quantization === requestedVariant.toUpperCase() && artifactRole({ path: choice.id }) === 'model');
      quantization.value = matches.length === 1 ? matches[0]!.id : ''; candidate.value = '';
      requestedVariantUnresolved.value = matches.length !== 1;
    } else if (!sameRepository || !nextChoices.some(choice => choice.id === quantization.value)) {
      quantization.value = nextChoices[0]?.id ?? ''; candidate.value = '';
    }
    if (sameRepository) {
      candidate.value = next.models.some(model => model.label === previousCandidate) ? previousCandidate! : '';
      projector.value = next.projectors.some(file => file.path === previousProjector) ? previousProjector : '';
    } else {
      candidate.value = ''; projector.value = ''; multimodal.value = next.projectors.length ? 'on' : 'off';
    }
    if (!next.projectors.length) multimodal.value = 'off';
    catalog.value = next; checkedInput.value = submittedInput;
  } catch {
    if (!controller.signal.aborted) error.value = 'failed';
  } finally {
    inspecting = false; active.value = undefined;
  }
}
function download({ selection }: { selection: DownloadSelection }): void {
  if (active.value || props.disabled || deleting.value) return;
  error.value = undefined;
  // Explicit Download/Resume keeps the displayed revision and files immutable.
  // The page-level queue owns the writer, not this component's mount lifetime.
  queue.enqueue({ key: selectionKey({ selection }), repository: selection.repository, source: 'repository', prepare: async () => selection });
}
async function start(): Promise<void> {
  const current = catalog.value; const model = selected.value;
  if (!current || !model || needsProjector.value || !catalogCurrent.value || localAvailability.value !== 'missing') return;
  download({ selection: { repository: current.repository, revision: current.revision, files: selectedFiles.value } });
}
async function remove({ repository }: { repository: string }): Promise<void> {
  if (deleting.value || active.value || props.disabled || queuedDownloadBusy.value) return;
  deleting.value = true; error.value = undefined;
  try {
    const plan = await confirmRemoval({ id: `hf.co/${repository}` });
    if (!plan || disposed) return;
    const result = await cancelDownload({ repository, plan });
    switch (result) {
    case 'changed': error.value = 'changed'; break;
    case 'deleted':
      for (const job of queue.jobs.value) if (job.repository === repository) queue.forget({ id: job.id });
      break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
    await refresh(); emit('changed');
  } catch {
    error.value = 'failed';
  } finally {
    deleting.value = false;
  }
}
watch(selectionToCheck, () => emit('selectionChanged'), { flush: 'sync' });
watch([selectionToCheck, () => props.disabled, active, deleting, localCheckVersion], async ([selection, disabled, operation, removing], _previous, onCleanup) => {
  let cancelled = false; onCleanup(() => {
    cancelled = true;
  });
  if (!selection) {
    localAvailability.value = 'missing'; return;
  }
  localAvailability.value = 'checking';
  if (disabled || operation || removing || disposed) return;
  try {
    const model = await installedSelection({ selection });
    if (cancelled || disposed) return;
    if (!model) {
      const wasInstalled = lastAnnouncedSelection === JSON.stringify(selection);
      localAvailability.value = 'missing'; lastAnnouncedSelection = undefined;
      if (wasInstalled) {
        emit('selectionChanged'); emit('changed');
      }
      return;
    }
    localAvailability.value = 'installed';
    const identity = JSON.stringify(selection);
    if (identity !== lastAnnouncedSelection) {
      lastAnnouncedSelection = identity; emit('modelReady', model);
    }
  } catch {
    if (!cancelled && !disposed) {
      localAvailability.value = 'unavailable'; error.value = 'failed';
    }
  }
}, { immediate: true });
watch(() => props.disabled, disabled => {
  if (!disabled) void refresh();
});
watch([() => props.modelPreset, () => props.disabled, active], ([preset, disabled, operation]) => {
  if (!preset || disabled || disposed) return;
  if (operation) {
    if (inspecting && preset !== inspectionPreset) operation.abort();
    return;
  }
  if (!preset.claim()) return;
  inspectionPreset = preset;
  input.value = preset.input;
  // Privacy exception: an explicit llama-cpp-browser-model URL requests this
  // repository's metadata. An ordinary mount must not inspect or prefetch it,
  // and even a model URL never authorizes starting a payload download.
  void inspect();
}, { immediate: true, flush: 'post' });
watch(queue.changed, () => {
  recheckLocalFiles(); void refresh(); emit('changed');
});
watch([active, queuedDownloadBusy, deleting], ([operation, downloading, removing]) => {
  emit('busy', operation !== undefined || downloading || removing);
}, { immediate: true });
onMounted(() => {
  window.addEventListener('focus', recheckLocalFiles);
  void refresh();
});
onUnmounted(() => {
  disposed = true; active.value?.abort(); window.removeEventListener('focus', recheckLocalFiles);
});
async function inspectRepository({ input: requestedInput }: { input: string }): Promise<void> {
  if (props.disabled || active.value || deleting.value || disposed) return;
  input.value = requestedInput;
  await inspect();
}
defineExpose({ inspectRepository, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-4 space-y-3" data-testid="llama-hf-manager">
    <div tw-class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><DownloadIcon tw-class="w-4 h-4 text-purple-500" />Hugging Face</h3>
      <label :for="`${id}-repository`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__repository() }}</label>
    </div>
    <fieldset :disabled="disabled || active !== undefined || deleting" tw-class="space-y-3 disabled:opacity-50">
      <div tw-class="space-y-2">
        <div tw-class="flex flex-col sm:flex-row gap-2">
          <input :id="`${id}-repository`" v-model="input" data-testid="llama-hf-repository" placeholder="owner/repository" tw-class="min-w-0 flex-1 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-purple-500/10 outline-none transition-all" @keydown.enter.prevent="inspect" />
          <button type="button" data-testid="llama-hf-inspect" :disabled="!input.trim()" tw-class="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-100 border border-gray-200 dark:border-gray-700 shadow-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all" @click="inspect"><SearchIcon tw-class="w-4 h-4" />{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__check_model() }}</button>
        </div>
      </div>
      <template v-if="catalog">
        <div tw-class="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="llama-hf-options">
          <div tw-class="flex flex-wrap items-center gap-2 max-w-full">
            <label :for="`${id}-model`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__quantization() }}</label>
            <div tw-class="relative w-40 max-w-full">
              <select :id="`${id}-model`" v-model="quantization" :title="selectedChoiceLabel" data-testid="llama-hf-model" tw-class="appearance-none block w-full pl-3 pr-9 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-purple-500/10 outline-none transition-all">
                <option v-if="!selectedChoice" value="">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_model_files() }}</option>
                <option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.displayLabel }} · {{ size({ bytes: choice.models[0]!.size }) }}</option>
              </select>
              <span aria-hidden="true" data-testid="llama-hf-selected-model" tw-class="absolute inset-px flex items-center rounded-xl bg-white dark:bg-gray-900 pl-3 pr-9 text-sm font-medium text-gray-800 dark:text-gray-100 pointer-events-none"><span tw-class="truncate">{{ selectedChoiceLabel }}</span></span>
              <ChevronDownIcon tw-class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
            <p v-if="catalog.models.length === 0" tw-class="w-full text-xs text-gray-500">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__no_complete_gguf_models_found() }}</p>
          </div>
          <!-- Repository support controls are hidden when no companion file exists. -->
          <div v-if="catalog.projectors.length" tw-class="flex items-center gap-2">
            <div>
              <p :id="`${id}-multimodal-label`" tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__multimodal_support() }}</p>
            </div>
            <button type="button" role="switch" data-testid="llama-hf-multimodal" :disabled="!catalog.projectors.length" :aria-checked="multimodal === 'on'" :aria-labelledby="`${id}-multimodal-label`" :aria-describedby="`${id}-multimodal-help`" :tw-class="['relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60', multimodal === 'on' ? 'bg-purple-600' : 'bg-gray-300 dark:bg-gray-700']" @click="multimodal = multimodal === 'on' ? 'off' : 'on'"><span aria-hidden="true" :tw-class="['block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none', multimodal === 'on' ? 'translate-x-[18px]' : 'translate-x-[3px]']" /></button>
          </div>
          <div v-if="catalog.projectors.length && multimodal === 'on'" tw-class="flex flex-wrap items-center gap-2 max-w-full">
            <label :for="`${id}-projector`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__multimodal_quantization() }}</label>
            <div tw-class="relative w-32 max-w-full">
              <select :id="`${id}-projector`" :value="selectedProjector?.path ?? ''" :title="selectedProjectorLabel" data-testid="llama-hf-projector" tw-class="appearance-none block w-full pl-3 pr-9 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-800 dark:text-gray-100" @change="projector = ($event.target as HTMLSelectElement).value">
                <option value="">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_companion_file() }}</option>
                <option v-for="option in projectorOptions" :key="option.file.path" :value="option.file.path">{{ option.label }} · {{ size({ bytes: option.file.size }) }}</option>
              </select>
              <span aria-hidden="true" data-testid="llama-hf-selected-projector" tw-class="absolute inset-px flex items-center rounded-xl bg-white dark:bg-gray-900 pl-3 pr-9 text-sm font-medium text-gray-800 dark:text-gray-100 pointer-events-none"><span tw-class="truncate">{{ selectedProjectorLabel }}</span></span>
              <ChevronDownIcon tw-class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            </div>
          </div>
          <div tw-class="flex flex-wrap items-center gap-2 ml-auto">
            <div data-testid="llama-hf-total" :title="lazyStrings.LlamaCppBrowserHuggingFaceManager__total_download_size()" tw-class="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400"><HardDriveIcon tw-class="w-3.5 h-3.5" aria-hidden="true" /><span tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__total_download_size() }}</span><span tw-class="font-bold text-gray-800 dark:text-gray-100 tabular-nums">{{ selected && !needsProjector ? size({ bytes: total }) : '—' }}</span></div>
            <button type="button" data-testid="llama-hf-download" :disabled="!selected || needsProjector || !catalogCurrent || localAvailability !== 'missing'" tw-class="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-bold rounded-xl bg-purple-600 text-white hover:bg-purple-700 shadow-lg shadow-purple-500/20 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all" @click="start"><Loader2Icon v-if="localAvailability === 'checking'" tw-class="w-4 h-4 animate-spin" /><DownloadIcon v-else tw-class="w-4 h-4" />{{ downloadLabel }}</button>
          </div>
        </div>
        <p v-if="requestedVariantUnresolved && !selected" role="status" data-testid="llama-hf-requested-variant-unresolved" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__requested_variant_needs_selection() }}</p>
        <div v-if="needsVariant || needsProjector" tw-class="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400" data-testid="llama-hf-selection-required">
          <AlertCircleIcon tw-class="w-4 h-4 shrink-0" />
          <button type="button" tw-class="text-left underline underline-offset-2" @click="details && (details.open = true)">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_between_variants_in_download_details() }}</button>
        </div>



      </template>
    </fieldset>
    <div v-if="active" role="status" tw-class="flex items-center justify-between gap-3 py-2 text-xs text-gray-500 dark:text-gray-400" data-testid="llama-hf-active-progress">
      <span tw-class="inline-flex items-center gap-2"><Loader2Icon tw-class="w-4 h-4 animate-spin" />{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__checking_model() }}</span>
      <button type="button" tw-class="px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800" @click="active?.abort()">{{ lazyStrings.SHARED__cancel() }}</button>
    </div>
    <div v-for="job in repositoryJobs" :key="job.id" data-testid="llama-hf-download-job" tw-class="space-y-2 rounded-xl border border-gray-100 dark:border-gray-800 p-3">
      <p tw-class="text-[10px] text-gray-500 dark:text-gray-400 break-all">Hugging Face · {{ job.repository }}</p>
      <LlamaCppBrowserDownloadJob :job="job" :disabled="disabled || deleting" @resume="job.selection && download({ selection: job.selection })" />
      <button v-if="job.status === 'paused' || job.status === 'failed'" type="button" data-testid="llama-hf-delete" :disabled="disabled || active !== undefined || deleting || queuedDownloadBusy" tw-class="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[10px] font-bold text-gray-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed" @click="remove({ repository: job.repository })"><Trash2Icon tw-class="w-3 h-3" />{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__cancel_and_delete() }}</button>
    </div>
    <details v-if="catalog" ref="details" data-testid="llama-hf-details" tw-class="text-xs text-gray-500 dark:text-gray-400">
      <summary tw-class="cursor-pointer font-semibold py-1 hover:text-purple-600 dark:hover:text-purple-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__download_details() }}</summary>
      <div tw-class="mt-3 space-y-4">
        <a :href="`https://huggingface.co/${repositoryUrlPath({ repository: catalog.repository })}`" target="_blank" rel="noopener noreferrer" data-testid="llama-hf-repository-link" tw-class="inline-flex items-center gap-1.5 text-gray-500 hover:text-purple-600 dark:hover:text-purple-400 break-all"><span>Hugging Face · {{ catalog.repository }}</span><ExternalLinkIcon tw-class="w-3 h-3 shrink-0" /></a>
        <p :id="`${id}-multimodal-help`" tw-class="leading-relaxed">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__download_companion_files_for_supported_models() }}</p>
        <div v-if="(selectedChoice?.models.length ?? 0) > 1" tw-class="space-y-2">
          <label :for="`${id}-variant`" tw-class="block font-bold">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__model_variant() }}</label>
          <select :id="`${id}-variant`" v-model="candidate" :disabled="disabled || active !== undefined || deleting" data-testid="llama-hf-variant" tw-class="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100">
            <option value="">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_model_files() }}</option>
            <option v-for="model in selectedChoice?.models" :key="model.label" :value="model.label">{{ model.label }} · {{ size({ bytes: model.size }) }}</option>
          </select>
        </div>
        <div data-testid="llama-hf-files"><LlamaCppBrowserDownloadPlanFiles :repository="catalog.repository" :revision="catalog.revision" :files="selectedFiles" /></div>
      </div>
    </details>
    <p v-if="error" role="alert" tw-class="flex items-start gap-2 rounded-xl p-3 bg-red-50 dark:bg-red-900/10 text-xs text-red-700 dark:text-red-400"><AlertCircleIcon tw-class="w-4 h-4 shrink-0" />{{ errorMessage }}</p>
    <ul v-if="visiblePending.length" tw-class="space-y-4">
      <li v-for="job in visiblePending" :key="job.selection.repository" data-testid="llama-hf-pending" tw-class="space-y-3 py-2">
        <div tw-class="flex items-center gap-3">
          <div tw-class="w-8 h-8 rounded-xl flex items-center justify-center border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/30 shadow-sm shrink-0"><PauseIcon tw-class="w-4 h-4 text-gray-400" /></div>
          <div tw-class="flex-1 min-w-0">
            <div tw-class="flex items-start justify-between gap-3 mb-2">
              <div tw-class="min-w-0 space-y-0.5"><p tw-class="text-[10px] font-bold text-gray-600 dark:text-gray-300 tracking-wider">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__download_paused() }}</p><p tw-class="text-[9px] text-gray-400 font-medium break-all">hf.co/{{ job.selection.repository }}</p></div>
              <span tw-class="text-[10px] font-bold text-gray-400 tabular-nums shrink-0 mt-0.5">{{ percentage({ completed: job.bytes.reduce((sum, bytes) => sum + bytes, 0), total: job.selection.files.reduce((sum, file) => sum + file.size, 0) }) }}%</span>
            </div>
            <div role="progressbar" :aria-label="lazyStrings.LlamaCppBrowserHuggingFaceManager__download_paused()" :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="percentage({ completed: job.bytes.reduce((sum, bytes) => sum + bytes, 0), total: job.selection.files.reduce((sum, file) => sum + file.size, 0) })" tw-class="h-1 w-full bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden"><div tw-class="h-full rounded-full bg-purple-400/60 dark:bg-purple-500/50" :style="{ width: `${percentage({ completed: job.bytes.reduce((sum, bytes) => sum + bytes, 0), total: job.selection.files.reduce((sum, file) => sum + file.size, 0) })}%` }" /></div>
          </div>
        </div>
        <div tw-class="ml-11 flex flex-wrap items-center justify-between gap-3">
          <p tw-class="text-[9px] text-gray-400 font-medium tabular-nums">{{ size({ bytes: job.bytes.reduce((sum, bytes) => sum + bytes, 0) }) }} / {{ size({ bytes: job.selection.files.reduce((sum, file) => sum + file.size, 0) }) }}</p>
          <div tw-class="flex items-center gap-2">
            <button type="button" :disabled="disabled || active !== undefined || deleting" data-testid="llama-hf-resume" tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-bold text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" @click="download({ selection: job.selection })"><PlayIcon tw-class="w-3 h-3" />{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__resume() }}</button>
            <button type="button" :disabled="disabled || active !== undefined || deleting || queuedDownloadBusy" data-testid="llama-hf-delete" tw-class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-bold text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" @click="remove({ repository: job.selection.repository })"><Trash2Icon tw-class="w-3 h-3" />{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__cancel_and_delete() }}</button>
          </div>
        </div>
      </li>
    </ul>
  </section>
  <LlamaCppBrowserDeletionDialog :request="deletionRequest" @confirm="finishDeletion({ plan: $event })" @cancel="finishDeletion({ plan: undefined })" />
</template>
