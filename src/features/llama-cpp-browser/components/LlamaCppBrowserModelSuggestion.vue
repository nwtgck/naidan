<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { AlertCircleIcon, ChevronDownIcon, DownloadIcon, ExternalLinkIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { preferredQuantizationHint, suggestedQuantizationLabel, suggestionDownloadKey, type ModelSuggestion, type MultimodalDownload } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { findLocalSuggestedModel, resolveSuggestionPlan } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import { installedSelection, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { repositoryUrlPath, type DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import LlamaCppBrowserDefaultModelAction from './LlamaCppBrowserDefaultModelAction.vue';
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';
import LlamaCppBrowserDownloadPlanFiles from './LlamaCppBrowserDownloadPlanFiles.vue';
const props = defineProps<{ suggestion: ModelSuggestion, models: LocalModel[], disabled: boolean, defaultModel: DefaultModelContext | undefined, defaultActionDisabled: boolean }>();
const emit = defineEmits<{ selectDefault: [model: LocalModel] }>();
const id = useId();
const queue = getDownloadQueue();
const multimodal = ref<MultimodalDownload>('off');
const quantizationId = ref(preferredQuantizationHint({ suggestion: props.suggestion }).id);
const quantization = computed(() => props.suggestion.quantizationHints.find(choice => choice.id === quantizationId.value) ?? preferredQuantizationHint({ suggestion: props.suggestion }));
const detailsOpen = ref(false);
// Preview snapshots belong to a repository, not a row. Switching to a different
// source must not expose or download the previous source's files/projector.
// Same-source option changes can recompute a plan locally without another request.
const catalogs = shallowRef<ReadonlyMap<string, RepositoryCatalog>>(new Map());
const catalog = computed(() => catalogs.value.get(quantization.value.repository.toLowerCase()));
const inspecting = shallowRef<AbortController>();
const previewError = ref(false);
const localError = ref(false);
const checkingLocal = ref(false);
const installed = shallowRef<LocalModel>();
let disposed = false;
const jobKey = computed(() => suggestionDownloadKey({ suggestionId: props.suggestion.id, quantization: quantization.value, multimodal: multimodal.value }));
const job = computed(() => queue.jobs.value.find(entry => entry.key === jobKey.value));
// Recover the exact source/quantization/options of an in-flight or paused intent
// after a settings-tab remount. Never inspect or resume just to render this row.
for (const choice of props.suggestion.quantizationHints) {
  for (const requestedMultimodal of ['off', 'on'] as const) {
    const key = suggestionDownloadKey({ suggestionId: props.suggestion.id, quantization: choice, multimodal: requestedMultimodal });
    if (queue.jobs.value.some(entry => entry.key === key && (jobIsBusy({ job: entry }) || entry.status === 'paused'))) {
      quantizationId.value = choice.id; multimodal.value = requestedMultimodal;
    }
  }
}
const busy = computed(() => jobIsBusy({ job: job.value }));
// Keep one row's submitted intent immutable, including while paused for resume.
// Other rows remain selectable/queueable. Waiting cancellation unlocks this row.
const optionsLocked = computed(() => props.disabled || busy.value || inspecting.value !== undefined || job.value?.status === 'paused');
const preview = computed(() => {
  if (!catalog.value) return { status: 'unchecked' } as const;
  try {
    return { status: 'ready', selection: resolveSuggestionPlan({ quantization: quantization.value, catalog: catalog.value, multimodal: multimodal.value }) } as const;
  } catch {
    return { status: 'unavailable' } as const;
  }
});
const previewSelection = computed(() => {
  const current = preview.value;
  switch (current.status) {
  case 'ready': return current.selection;
  case 'unchecked': case 'unavailable': return undefined;
  default: { const exhaustive: never = current; throw new Error(String(exhaustive)); }
  }
});
const plan = computed<DownloadSelection | undefined>(() => {
  // A queued/resumed job keeps its exact revision and option snapshot. The
  // plan displayed while it runs is the plan the writer actually receives.
  if (job.value?.selection) return job.value.selection;
  return previewSelection.value;
});
// An absent upstream projector may prevent enabling multimodal, but must never
// prevent turning it OFF to recover from stale hints or a source change.
const canUseMultimodal = computed(() => catalog.value ? catalog.value.projectors.length > 0 : quantization.value.approximateMultimodalBytes !== undefined);
const totalLabel = computed(() => {
  if (plan.value) return formatDownloadBytes({ bytes: plan.value.files.reduce((sum, file) => sum + file.size, 0) });
  let bytes = quantization.value.approximateModelBytes;
  switch (multimodal.value) {
  case 'off': break;
  case 'on': bytes += quantization.value.approximateMultimodalBytes ?? 0; break;
  default: { const exhaustive: never = multimodal.value; throw new Error(String(exhaustive)); }
  }
  return lazyStrings.llamaCppBrowserDownloads__approximately_size({ size: formatDownloadBytes({ bytes }) });
});

// Only local storage is read here. Approximate sizes cannot determine installed
// state, and having Q8_0 (or an auxiliary GGUF) must not satisfy Q4_K_M.
watch([() => props.models, quantization, multimodal, plan, queue.changed], async (_values, _old, onCleanup) => {
  let cancelled = false; onCleanup(() => {
    cancelled = true;
  });
  installed.value = undefined; localError.value = false; checkingLocal.value = true;
  try {
    const known = findLocalSuggestedModel({ quantization: quantization.value, models: props.models });
    let found: LocalModel | undefined;
    if (plan.value) found = await installedSelection({ selection: plan.value });
    else if (known && multimodal.value === 'off') found = known;
    else if (known) {
      const directories = await repositoryDirectories({ repository: quantization.value.repository });
      if (directories.some(directory => directory.id === known.id && directory.projectorPath !== undefined)) found = known;
    }
    if (!cancelled && !disposed) installed.value = found;
  } catch {
    if (!cancelled && !disposed) localError.value = true;
  } finally {
    if (!cancelled && !disposed) checkingLocal.value = false;
  }
}, { immediate: true });

function selectQuantization({ event }: { event: Event }): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const choice = props.suggestion.quantizationHints.find(entry => entry.id === target.value);
  if (optionsLocked.value || !choice) {
    target.value = quantization.value.id; return;
  }
  quantizationId.value = choice.id;
  previewError.value = false;
  // No inspect(), prefetch or fallback source lookup: this selection is local.
}
async function checkContents(): Promise<void> {
  if (optionsLocked.value) return;
  const requested = quantization.value;
  const requestedKey = jobKey.value;
  const controller = new AbortController(); inspecting.value = controller; previewError.value = false;
  try {
    // Privacy boundary: ONLY this button or Download authorizes metadata I/O.
    // Details expansion and quantization/multimodal changes never call it.
    const result = await getMetadataSession().inspect({ input: requested.repository, signal: controller.signal, freshness: catalog.value ? 'refresh' : 'reuse' });
    if (!disposed && !controller.signal.aborted) {
      if (job.value && jobKey.value === requestedKey && !busy.value) queue.forget({ id: job.value.id });
      catalogs.value = new Map(catalogs.value).set(requested.repository.toLowerCase(), result);
    }
  } catch {
    if (!disposed && !controller.signal.aborted && jobKey.value === requestedKey) previewError.value = true;
  } finally {
    if (!disposed && inspecting.value === controller) inspecting.value = undefined;
  }
}
function download(): void {
  if (props.disabled || busy.value || inspecting.value || checkingLocal.value || localError.value) return;
  // Capture all mutable UI options BEFORE enqueueing. Changing another row or
  // unmounting this component cannot change this explicit user's request.
  const requestedQuantization = quantization.value;
  const requestedMultimodal = multimodal.value;
  const pinned = job.value?.selection ?? (previewSelection.value);
  previewError.value = false;
  queue.enqueue({ key: jobKey.value, repository: requestedQuantization.repository, source: 'suggestion', prepare: async ({ signal }) => {
    if (pinned) return pinned;
    const resolved = await getMetadataSession().inspect({ input: requestedQuantization.repository, signal, freshness: 'reuse' });
    return resolveSuggestionPlan({ quantization: requestedQuantization, catalog: resolved, multimodal: requestedMultimodal });
  } });
}
onUnmounted(() => {
  disposed = true; inspecting.value?.abort();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <article :data-testid="`llama-suggestion-${suggestion.id}`" tw-class="min-w-0 py-3">
    <div tw-class="flex flex-wrap items-center justify-between gap-2" data-testid="llama-suggestion-heading">
      <div tw-class="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-1" data-testid="llama-suggestion-title-options">
        <h4 :id="`${id}-name`" tw-class="min-w-0 break-words text-sm font-bold text-gray-800 dark:text-gray-100">{{ suggestion.name }}</h4>
        <!-- Inline selects create a baseline line box in a plain wrapper, shifting
             the control away from the title/chevron center. Keep both boxes explicit. -->
        <div tw-class="relative flex max-w-full items-center">
          <label :id="`${id}-quantization-label`" :for="`${id}-quantization`" tw-class="sr-only">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__quantization() }}</label>
          <select
            :id="`${id}-quantization`"
            :value="quantization.id"
            :aria-labelledby="`${id}-name ${id}-quantization-label`"
            :disabled="optionsLocked || suggestion.quantizationHints.length === 1"
            data-testid="llama-suggestion-quantization"
            tw-class="block h-6 max-w-full appearance-none rounded-md border border-transparent bg-transparent py-0 pl-1.5 pr-5 text-[11px] leading-4 font-normal text-gray-500 dark:text-gray-400 enabled:hover:border-gray-200 dark:enabled:hover:border-gray-700 enabled:hover:bg-gray-100/70 dark:enabled:hover:bg-gray-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            @change="selectQuantization({ event: $event })"
          >
            <option v-for="choice in suggestion.quantizationHints" :key="choice.id" :value="choice.id" tw-class="bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-200">{{ suggestedQuantizationLabel({ quantization: choice }) }}</option>
          </select>
          <ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute inset-y-0 right-1 my-auto w-2.5 h-2.5 text-gray-400 dark:text-gray-500" />
        </div>
      </div>
      <LlamaCppBrowserDefaultModelAction v-if="installed && !busy" :model="installed" :current="defaultModel" :disabled="disabled || defaultActionDisabled" tw-class="ml-auto" @select="emit('selectDefault', $event)" />
      <button
        v-else-if="!busy && job?.status !== 'paused' && job?.status !== 'failed'"
        type="button"
        data-testid="llama-suggestion-download"
        :disabled="disabled || checkingLocal || inspecting !== undefined || localError"
        tw-class="ml-auto inline-flex max-w-full items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs font-medium text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 transition-colors"
        @click="download"
      >
        <Loader2Icon v-if="checkingLocal" tw-class="w-3.5 h-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        <DownloadIcon v-else tw-class="w-3.5 h-3.5 shrink-0" />
        {{ lazyStrings.llamaCppBrowserDownloads__download() }}
      </button>
    </div>
    <!-- Keep options and Details together instead of allocating a row to each.
         Wrap the metadata first on narrow panels or in longer translations. -->
    <div tw-class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="llama-suggestion-metadata">
      <p tw-class="min-w-0 break-words text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">{{ suggestion.developer }} · {{ totalLabel }}</p>
      <div tw-class="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1" data-testid="llama-suggestion-options">
        <div v-if="quantization.approximateMultimodalBytes !== undefined || canUseMultimodal || multimodal === 'on'" tw-class="flex items-center gap-2">
          <span :id="`${id}-multimodal`" tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__multimodal_support() }}</span>
          <button type="button" role="switch" :aria-checked="multimodal === 'on'" :aria-labelledby="`${id}-multimodal`" data-testid="llama-suggestion-multimodal" :disabled="optionsLocked || (!canUseMultimodal && multimodal === 'off')" :tw-class="['relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed', multimodal === 'on' ? 'bg-purple-600' : 'bg-gray-300 dark:bg-gray-700']" @click="multimodal = multimodal === 'off' ? 'on' : 'off'"><span :tw-class="['inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200 mt-0.5 motion-reduce:transition-none', multimodal === 'on' ? 'translate-x-4' : 'translate-x-0.5']" /></button>
        </div>
        <button
          type="button"
          :aria-expanded="detailsOpen"
          :aria-controls="`${id}-details`"
          data-testid="llama-suggestion-details-toggle"
          tw-class="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 transition-colors"
          @click="detailsOpen = !detailsOpen"
        >
          {{ lazyStrings.llamaCppBrowserDownloads__details() }}
          <ChevronDownIcon aria-hidden="true" :tw-class="['w-3 h-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none', { 'rotate-180': detailsOpen }]" />
        </button>
      </div>
    </div>
    <LlamaCppBrowserDownloadJob v-if="job && (!installed || busy) && job.status !== 'complete' && job.status !== 'cancelled'" :job="job" :disabled="disabled || checkingLocal || localError" tw-class="mt-2" @resume="download" />
    <p v-if="localError" role="alert" tw-class="mt-2 text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    <!-- Expansion is local presentation only. Keeping the panel mounted preserves
         its plan, but inert removes hidden links/buttons from keyboard focus. -->
    <div :id="`${id}-details`" class="suggestion-details" :class="{ 'suggestion-details-open': detailsOpen }" :inert="detailsOpen ? undefined : true" :aria-hidden="!detailsOpen" data-testid="llama-suggestion-details">
      <div class="suggestion-details-inner">
        <div tw-class="pt-2 space-y-2 text-xs text-gray-500 dark:text-gray-400">
          <!-- A dedicated row keeps long repository names separate from actions. -->
          <div tw-class="min-w-0" data-testid="llama-suggestion-repository-row">
            <a :href="`https://huggingface.co/${repositoryUrlPath({ repository: quantization.repository })}`" target="_blank" rel="noopener noreferrer" data-testid="llama-suggestion-repository" tw-class="flex w-fit max-w-full min-w-0 items-start gap-1.5 rounded-sm text-purple-600 dark:text-purple-400 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500">
              <span tw-class="min-w-0 break-all leading-relaxed">Hugging Face · {{ quantization.repository }}</span>
              <ExternalLinkIcon aria-hidden="true" tw-class="mt-0.5 w-3 h-3 shrink-0" />
            </a>
          </div>
          <div tw-class="flex flex-wrap items-center justify-between gap-2" data-testid="llama-suggestion-plan-toolbar">
            <h5 tw-class="font-medium">{{ lazyStrings.llamaCppBrowserDownloads__download_contents() }}</h5>
            <button type="button" data-testid="llama-suggestion-check" :disabled="optionsLocked" tw-class="inline-flex max-w-full items-center justify-center gap-1.5 rounded-md px-1 py-1 text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:underline underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 transition-colors" @click="checkContents">
              <Loader2Icon v-if="inspecting" tw-class="w-3 h-3 shrink-0 animate-spin motion-reduce:animate-none" />
              {{ inspecting ? lazyStrings.llamaCppBrowserDownloads__checking_hugging_face() : plan ? lazyStrings.llamaCppBrowserDownloads__refresh_download_contents() : lazyStrings.llamaCppBrowserDownloads__check_download_contents() }}
            </button>
          </div>
          <template v-if="plan">
            <LlamaCppBrowserDownloadPlanFiles :repository="plan.repository" :revision="plan.revision" :files="plan.files" />
            <p tw-class="text-right tabular-nums font-medium">{{ lazyStrings.llamaCppBrowserDownloads__total() }} {{ formatDownloadBytes({ bytes: plan.files.reduce((sum, file) => sum + file.size, 0) }) }}</p>
          </template>
          <p v-if="preview.status === 'unavailable'" role="alert" tw-class="flex gap-2 text-amber-700 dark:text-amber-400"><AlertCircleIcon tw-class="w-3.5 h-3.5 shrink-0" />{{ lazyStrings.llamaCppBrowserDownloads__plan_needs_review() }}</p>
          <p v-if="previewError" role="alert" tw-class="text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__download_failed_retry_or_resume() }}</p>
        </div>
      </div>
    </div>
  </article>
</template>
<style scoped>
.suggestion-details { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows 220ms ease, opacity 180ms ease; }
.suggestion-details-open { grid-template-rows: 1fr; opacity: 1; }
.suggestion-details-inner { min-height: 0; overflow: hidden; }
@media (prefers-reduced-motion: reduce) { .suggestion-details { transition: none; } }
</style>
