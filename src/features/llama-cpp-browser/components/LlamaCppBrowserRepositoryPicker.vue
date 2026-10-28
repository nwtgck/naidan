<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, FolderSearchIcon, HardDriveIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { DownloadDestination } from '@/01-models/download';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { AuthorizeModelLaunchDestination } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { destinationKey } from '@/features/llama-cpp-browser/runtime/model-destination';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { confirmModelLaunchConfiguration, initialRepositorySelection, modelLaunchChoices } from '@/features/llama-cpp-browser/model-launch/target';
import LlamaCppBrowserModelConfiguration from './LlamaCppBrowserModelConfiguration.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{
  select: [request: { target: ModelLaunchTarget, destination: DownloadDestination, authorizeDestination: AuthorizeModelLaunchDestination }],
  'select-model': [model: LocalModel],
  'view-change': [view: 'search' | 'configuration'],
}>();
const id = useId();
const input = ref('');
const catalog = shallowRef<RepositoryCatalog>();
// Report the view before its DOM changes so the owning panel can retain the
// search position before the shorter configuration view clamps scrollTop.
watch(() => catalog.value === undefined ? 'search' : 'configuration', view => emit('view-change', view), { flush: 'sync' });
const active = shallowRef<AbortController>();
const error = ref(false);
const failureContext = ref<'metadata'>();
const mainPath = ref('');
const companionPath = ref('');
const multimodal = ref<'on' | 'off'>('off');
const choices = computed(() => {
  const options = catalog.value === undefined ? [] : modelLaunchChoices({ catalog: catalog.value });
  return options.map(option => ({ ...option, size: option.models.reduce((sum, model) => sum + model.size, 0), displayLabel: options.filter(other => other.label === option.label).length > 1 ? `${option.label} (${option.primaryRelativePath})` : option.label }));
});
const target = computed(() => {
  if (catalog.value === undefined || !mainPath.value) {
    return undefined;
  }
  try {
    const companionFilePath = (() => {
      switch (multimodal.value) {
      case 'off': return undefined;
      case 'on': return companionPath.value || undefined;
      default: {
        const exhaustive: never = multimodal.value;
        throw new Error(String(exhaustive));
      }
      }
    })();
    return confirmModelLaunchConfiguration({ catalog: catalog.value, mainFilePath: mainPath.value, companionFilePath, multimodal: multimodal.value });
  } catch {
    return undefined;
  }
});
const bytes = computed(() => target.value?.selection.files.reduce((sum, file) => sum + file.size, 0));
const downloadDestination = useModelDownloadDestination({ blocked: () => props.disabled, changed: () => {} });
const { destination, revision: destinationRevision, unavailable: destinationUnavailable, failure: destinationFailure, persistence: destinationPersistence } = downloadDestination;
const destinationIdentity = computed(() => destinationKey({ destination: destination.value }));
const destinationBusy = downloadDestination.view.busy;
const saved = shallowRef<{ status: 'checking' | 'missing' | 'unavailable' } | { status: 'saved', model: LocalModel }>({ status: 'checking' });
watch([target, destinationIdentity, destinationRevision, destinationUnavailable, destinationPersistence, destinationBusy, () => props.disabled], async ([value, _destination, _revision, unavailable, persistence, busy, disabled], _previous, onCleanup) => {
  let current = true;
  onCleanup(() => {
    current = false;
  });
  saved.value = { status: 'checking' };
  // Retained, pre-rendered tabs may inspect saved handles, but never model files.
  if (value === undefined || disabled || busy || persistence !== 'saved') {
    return;
  }
  if (unavailable) {
    saved.value = { status: 'unavailable' };
    return;
  }
  try {
    const model = await installedSelection({ selection: value.selection, destination: destination.value });
    if (current) {
      saved.value = model === undefined ? { status: 'missing' } : { status: 'saved', model };
    }
  } catch {
    if (current) {
      saved.value = { status: 'unavailable' };
    }
  }
}, { immediate: true, flush: 'sync' });

function select(): void {
  const current = target.value;
  if (props.disabled || destinationBusy.value || destinationUnavailable.value || current === undefined) {
    return;
  }
  const local = saved.value;
  switch (local.status) {
  case 'saved':
    // Reading an installed host model does not require write permission.
    emit('select-model', local.model);
    break;
  case 'missing': emit('select', { target: current, destination: destination.value, authorizeDestination: downloadDestination.authorize });
    break;
  case 'checking': case 'unavailable': break;
  default: {
    const exhaustive: never = local;
    throw new Error(String(exhaustive));
  }
  }
}

function reset(): void {
  active.value?.abort();
  active.value = undefined;
  catalog.value = undefined;
  error.value = false;
  failureContext.value = undefined;
}

watch(input, reset, { flush: 'sync' });
watch(() => props.disabled, disabled => {
  if (disabled) {
    active.value?.abort();
  }
});
onUnmounted(reset);

async function checkRepository({ value }: { value: string }): Promise<void> {
  if (props.disabled) {
    return;
  }
  input.value = value;
  reset();
  const controller = new AbortController();
  active.value = controller;
  let readingMetadata = false;
  try {
    const parsed = parseRepository({ input: value });
    // This explicit repository/search-result action authorizes metadata only.
    readingMetadata = true;
    const found = await getMetadataSession().inspect({ input: value, signal: controller.signal, freshness: 'reuse' });
    readingMetadata = false;
    if (controller.signal.aborted || active.value !== controller) {
      return;
    }
    catalog.value = found;
    const initial = initialRepositorySelection({ catalog: found, requestedVariant: parsed.requestedVariant });
    mainPath.value = initial.mainPath;
    companionPath.value = initial.companionPath;
    multimodal.value = initial.multimodal;
    error.value = modelLaunchChoices({ catalog: found }).length === 0;
  } catch {
    if (!controller.signal.aborted) {
      error.value = true;
      failureContext.value = readingMetadata ? 'metadata' : undefined;
    }
  } finally {
    if (active.value === controller) {
      active.value = undefined;
    }
  }
}

function submit({ event }: { event: KeyboardEvent }): void {
  if (!event.isComposing && event.keyCode !== 229) {
    void checkRepository({ value: input.value });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="chat-repository-picker" tw-class="space-y-5 text-left">
    <div v-if="catalog === undefined" tw-class="space-y-2">
      <label :for="`${id}-repository`" tw-class="text-xs font-semibold text-gray-600 dark:text-gray-300">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__specify_a_repository() }}</label>
      <div tw-class="flex gap-2">
        <input :id="`${id}-repository`" v-model="input" data-testid="chat-model-repository" placeholder="owner/model" :disabled="disabled" tw-class="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none focus:ring-4 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" @keydown.enter="submit({ event: $event })" />
        <LlamaCppBrowserModelActionButton data-testid="chat-model-repository-check" size="regular" :disabled="disabled || !input.trim() || active !== undefined" tw-class="shrink-0" @click="checkRepository({ value: input })"><Loader2Icon v-if="active" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 dark:text-blue-400 motion-reduce:animate-none" /><FolderSearchIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__check_repository() }}</LlamaCppBrowserModelActionButton>
      </div>
    </div>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__could_not_check_repository() }}</p>
    <CspMessageHint v-if="error && failureContext === 'metadata'" :target="{ kind: 'huggingface-metadata' }" activity-for-display-only="model-information" presentation="error" />
    <section v-if="catalog" data-testid="chat-model-configuration" tw-class="space-y-4">
      <div tw-class="space-y-2">
        <button type="button" data-testid="chat-model-back-to-search" :disabled="disabled" tw-class="group -ml-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100" @click="catalog = undefined"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__back_to_search() }}</button>
        <p data-testid="chat-model-repository-name" tw-class="break-words text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ catalog.repository }}</p>
      </div>
      <LlamaCppBrowserModelConfiguration v-model:quantization="mainPath" v-model:multimodal="multimodal" v-model:projector="companionPath" :choices="choices" :projectors="catalog.projectors" :disabled="disabled" :multimodal-description-id="undefined" />
      <div tw-class="space-y-3 border-t border-gray-100 pt-4 dark:border-gray-800">
        <div tw-class="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span v-if="bytes !== undefined" data-testid="chat-model-download-size" tw-class="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300"><HardDriveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />{{ formatDownloadBytes({ bytes }) }}</span>
          <span v-if="saved.status === 'saved'" data-testid="chat-model-saved" tw-class="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__saved() }}</span>
        </div>
        <div data-testid="chat-model-destination-row" tw-class="grid grid-cols-1 items-center gap-y-2">
          <LlamaCppBrowserDownloadDestination layout="field" :view="downloadDestination.view" :disabled="disabled" :layout-file="{ repository: catalog.repository, path: mainPath }" />
        </div>
        <p v-if="destinationFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
        <p v-else-if="saved.status === 'unavailable'" role="status" data-testid="chat-model-destination-unavailable" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ destination.kind === 'host' ? lazyStrings.LlamaCppBrowserDownloadDestination__reconnect_in_folder_settings() : lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p>
        <LlamaCppBrowserModelActionButton data-testid="chat-use-repository-model" appearance="primary" size="large" :aria-busy="target !== undefined && !disabled && destinationPersistence !== 'failed' && saved.status === 'checking' || undefined" :disabled="disabled || destinationBusy || destinationUnavailable || target === undefined || (saved.status !== 'saved' && saved.status !== 'missing')" tw-class="w-full" @click="select"><span tw-class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] items-center gap-3"><span tw-class="col-start-2 min-w-0 text-center">{{ lazyStrings.SHARED__use_model_in_this_chat() }}</span><span aria-hidden="true" tw-class="flex h-6 w-6 items-center justify-center rounded-lg bg-gray-100/80 text-blue-500 transition-[background-color,color] duration-200 group-hover:bg-blue-100/80 group-hover:text-blue-600 dark:bg-gray-700/60 dark:text-blue-400 dark:group-hover:bg-blue-500/15 dark:group-hover:text-blue-300 motion-reduce:transition-none"><ArrowRightIcon tw-class="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transform-none" /></span></span></LlamaCppBrowserModelActionButton>
        <CspMessageHint v-if="saved.status === 'missing'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" />
      </div>
    </section>
    <LlamaCppBrowserHuggingFaceSearch v-show="catalog === undefined" :disabled="disabled || active !== undefined || catalog !== undefined" :repository-input="input" scroll-owner="parent" @select="checkRepository({ value: $event })" />
  </div>
</template>
