<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue';
import { ArrowRightIcon, CheckIcon, CpuIcon, HardDriveIcon, Loader2Icon, ShieldCheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import { browserModelRepositoryPresentation } from '@/components/browser-model-presentation';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import type { DownloadDestination } from '@/01-models/download';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { AuthorizeModelLaunchDestination } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { modelLaunchEntryState, startModelLaunch } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { initialRepositorySelection, confirmModelLaunchConfiguration, modelLaunchChoices, rememberLaunchCatalog } from '@/features/llama-cpp-browser/model-launch/target';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { useModelDownloadDestination } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';
import { destinationKey, hostModelRoot } from '@/features/llama-cpp-browser/runtime/model-destination';
import LlamaCppBrowserModelConfiguration from './LlamaCppBrowserModelConfiguration.vue';
import LlamaCppBrowserDownloadDestination from './LlamaCppBrowserDownloadDestination.vue';
import LlamaCppBrowserLocalFileRecovery from './LlamaCppBrowserLocalFileRecovery.vue';

const props = defineProps<{ input: string, active: boolean, disabled: boolean, operation: symbol | undefined, selectionTarget: 'chat' | undefined, currentModelId?: string }>();
const emit = defineEmits<{ started: [operation: symbol], 'selection-changed': [] }>();
const heading = ref<HTMLElement>();
const catalog = shallowRef<RepositoryCatalog>();
const metadataStatus = ref<'loading' | 'ready' | 'failed'>('loading');
const mainPath = ref('');
const companionPath = ref('');
const multimodal = ref<'on' | 'off'>('off');
let controller: AbortController | undefined;
let requestedInput: string | undefined;
const launch = computed(() => {
  const state = modelLaunchEntryState.value;
  return state.status !== 'idle' && state.operation === props.operation ? state : undefined;
});
const starting = computed(() => launch.value?.status === 'checking');
const blocked = computed(() => !props.active || props.disabled || starting.value);
const downloadDestination = useModelDownloadDestination({ blocked: () => blocked.value, changed: () => {} });
const { destination, revision, persistence, unavailable, failure } = downloadDestination;
const choices = computed(() => {
  const available = catalog.value === undefined ? [] : modelLaunchChoices({ catalog: catalog.value });
  return available.map(choice => ({ ...choice, size: choice.models.reduce((sum, model) => sum + model.size, 0), displayLabel: available.filter(other => other.label === choice.label).length > 1 ? `${choice.label} (${choice.primaryRelativePath})` : choice.label }));
});
const selectedCompanionPath = computed(() => {
  const mode = multimodal.value;
  switch (mode) {
  case 'on': return companionPath.value || undefined;
  case 'off': return undefined;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
});
const target = computed(() => {
  if (catalog.value === undefined || !mainPath.value) {
    return undefined;
  }
  try {
    return confirmModelLaunchConfiguration({ catalog: catalog.value, mainFilePath: mainPath.value, companionFilePath: selectedCompanionPath.value, multimodal: multimodal.value });
  } catch {
    return undefined;
  }
});
const bytes = computed(() => target.value?.selection.files.reduce((sum, file) => sum + file.size, 0)
  ?? choices.value.find(choice => choice.primaryRelativePath === mainPath.value)?.size);
const model = computed(() => browserModelRepositoryPresentation({ repository: catalog.value?.repository ?? parseRepository({ input: props.input }).repository, bytes: bytes.value }));
const memoryGiB = computed(() => {
  const choice = choices.value.find(choice => choice.primaryRelativePath === mainPath.value);
  // Editorial hints only cover the named bundled variant, never an unrelated
  // file that happens to use the same number of quantization bits.
  if (choice?.quantization === undefined || choices.value.filter(other => other.quantization === choice.quantization).length !== 1) {
    return undefined;
  }
  const hint = modelSuggestions.flatMap(suggestion => suggestion.quantizationHints).find(hint => {
    if (hint.hfRepository.toLowerCase() !== model.value.repository.toLowerCase() || hint.preferredQuantization !== choice.quantization) {
      return false;
    }
    const labels = [hint.preferredQuantization];
    const checkpoint = hint.checkpoint;
    switch (checkpoint) {
    case 'qat': labels.push(`QAT-${hint.preferredQuantization}`);
      break;
    case 'standard': break;
    default: {
      const exhaustive: never = checkpoint;
      throw new Error(String(exhaustive));
    }
    }
    return labels.includes(choice.label.toUpperCase());
  });
  const mode = multimodal.value;
  switch (mode) {
  case 'on': return hint?.suggestedMultimodalMemoryGiB;
  case 'off': return hint?.suggestedMemoryGiB;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
});
type SavedState = { status: 'checking' | 'missing' | 'unavailable' } | { status: 'saved', model: LocalModel, root: FileSystemDirectoryHandle | undefined };
const saved = shallowRef<SavedState>({ status: 'checking' });
const destinationIdentity = computed(() => destinationKey({ destination: destination.value }));
watch([target, destinationIdentity, revision, persistence, unavailable, downloadDestination.view.busy, () => props.active], async ([selection, _identity, _revision, state, inaccessible, busy, active], _old, onCleanup) => {
  let current = true;
  onCleanup(() => {
    current = false;
  });
  saved.value = { status: 'checking' };
  if (selection === undefined || !active || state !== 'saved' || busy) {
    return;
  }
  if (inaccessible) {
    saved.value = { status: 'unavailable' };
    return;
  }
  const selectedDestination = destination.value;
  try {
    const root = await readRoot({ destination: selectedDestination });
    const found = await installedSelection({ selection: selection.selection, destination: selectedDestination, expectedRoot: root });
    if (current) {
      saved.value = found === undefined ? { status: 'missing' } : { status: 'saved', model: found, root };
    }
  } catch {
    if (current) {
      saved.value = { status: 'unavailable' };
    }
  }
}, { immediate: true, flush: 'sync' });

async function inspect(): Promise<void> {
  if (!props.active || props.disabled) {
    return;
  }
  controller?.abort();
  const request = new AbortController();
  controller = request;
  catalog.value = undefined;
  metadataStatus.value = 'loading';
  try {
    const parsed = parseRepository({ input: props.input });
    const found = await getMetadataSession().inspect({ input: props.input, signal: request.signal, freshness: 'reuse' });
    if (controller !== request || request.signal.aborted || !props.active) {
      return;
    }
    const initial = initialRepositorySelection({ catalog: found, requestedVariant: parsed.requestedVariant });
    mainPath.value = initial.mainPath;
    companionPath.value = initial.companionPath;
    multimodal.value = initial.multimodal;
    rememberLaunchCatalog({ catalog: found });
    catalog.value = found;
    metadataStatus.value = 'ready';
  } catch {
    if (controller === request && !request.signal.aborted) {
      metadataStatus.value = 'failed';
    }
  }
}

async function readRoot({ destination: requested }: { destination: DownloadDestination }): Promise<FileSystemDirectoryHandle | undefined> {
  switch (requested.kind) {
  case 'host': return hostModelRoot({ destination: requested, mode: 'read' });
  case 'opfs': return undefined;
  default: {
    const exhaustive: never = requested;
    throw new Error(String(exhaustive));
  }
  }
}

function start(): void {
  const selected = target.value;
  const local = saved.value;
  if (blocked.value || selected === undefined || persistence.value !== 'saved' || unavailable.value || downloadDestination.view.busy.value || modelLaunchEntryState.value.status === 'checking') {
    return;
  }
  let authorizeDestination: AuthorizeModelLaunchDestination;
  const status = local.status;
  switch (status) {
  case 'saved':
    if (local.status !== 'saved') {
      return;
    }
    authorizeDestination = async ({ destination: requested }) => {
      // A saved model needs only read access, with the same physical root that
      // was checked. Disappearance never grants permission to write new bytes.
      const root = await readRoot({ destination: requested });
      if (local.root !== undefined && (root === undefined || !await root.isSameEntry(local.root))) {
        throw new Error('The model destination changed');
      }
      return { destination: requested, expectedRoot: root };
    };
    break;
  case 'missing': authorizeDestination = downloadDestination.authorize;
    break;
  case 'checking': case 'unavailable': return;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
  // Retire failures first: a retry is a fresh click and fresh authorization,
  // while the target and selected destination stay explicit.
  emit('selection-changed');
  const operation = startModelLaunch({ target: selected, request: { input: selected.selection.repository, requestedVariant: selected.mainFilePath, multimodal: multimodal.value, destination: destination.value, source: 'hugging-face' }, authorizeDestination });
  emit('started', operation);
}

watch([mainPath, companionPath, multimodal, destinationIdentity], () => emit('selection-changed'), { flush: 'sync' });
watch([() => props.input, () => props.disabled], ([input, disabled]) => {
  if (requestedInput === input) {
    return;
  }
  controller?.abort();
  catalog.value = undefined;
  metadataStatus.value = 'loading';
  // The explicit selection can outlive a transient interaction lock while its
  // lazy UI loads. Resume that intent once; unlocking is not a refresh request.
  if (props.active && !disabled) {
    requestedInput = input;
    void inspect();
  }
}, { immediate: true });
watch(() => props.active, active => {
  if (!active) {
    controller?.abort();
  }
});
onUnmounted(() => controller?.abort());
void nextTick(() => heading.value?.focus({ preventScroll: true }));


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="repository-preview" tw-class="flex min-h-0 flex-1 flex-col">
    <div data-testid="discovery-detail-viewport" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-5 sm:px-8 sm:pt-8">
      <header tw-class="space-y-3">
        <p tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">{{ model.developer }}<span v-if="saved.status === 'saved'" data-testid="repository-preview-saved" tw-class="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3" />{{ saved.model.modelId === currentModelId ? lazyStrings.ModelDiscoveryPanel__in_use_in_this_chat() : lazyStrings.ModelDiscoveryPanel__saved() }}</span></p>
        <h3 ref="heading" tabindex="-1" tw-class="text-[clamp(28px,6vw,36px)] font-semibold leading-[1.15] tracking-tight text-gray-800 outline-none dark:text-gray-200 [overflow-wrap:anywhere]">{{ model.name }}</h3>
        <p tw-class="break-all text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ model.repository }}</p>
        <p tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.llamaCppBrowser__runs_in_your_browser() }}</p>
      </header>
      <div v-if="metadataStatus === 'loading'" role="status" data-testid="repository-preview-loading" tw-class="mt-8 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.BrowserModelPreparation__checking_model() }}</div>
      <div v-else-if="metadataStatus === 'failed'" data-testid="repository-preview-error" tw-class="mt-6 space-y-3 text-sm text-gray-600 dark:text-gray-400"><p role="alert">{{ lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p><button type="button" :disabled="blocked" data-testid="repository-preview-retry" tw-class="min-h-9 rounded-lg border border-gray-200 px-3 text-blue-600 dark:border-gray-700 dark:text-blue-400" @click="inspect">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button><HuggingFaceDownloadFailureHint><LlamaCppBrowserLocalFileRecovery :disabled="blocked" :accept-local-input="undefined" /></HuggingFaceDownloadFailureHint></div>
      <div v-else-if="catalog" tw-class="mt-7 space-y-5 border-t border-gray-100 pt-5 dark:border-gray-800">
        <LlamaCppBrowserModelConfiguration v-model:quantization="mainPath" v-model:multimodal="multimodal" v-model:projector="companionPath" :choices="choices" :projectors="catalog.projectors" :disabled="blocked" :multimodal-description-id="undefined" />
        <p v-if="!mainPath" role="status" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__variant_not_found() }}</p>
        <dl tw-class="grid grid-cols-2 gap-5">
          <div tw-class="space-y-2"><dt tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><HardDriveIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelDiscoveryPanel__model_size() }}</dt><dd data-testid="repository-preview-size" tw-class="text-base tabular-nums text-gray-700 dark:text-gray-300">{{ bytes === undefined ? lazyStrings.llamaCppBrowser__size_not_checked() : formatDownloadBytes({ bytes }) }}</dd></div>
          <div tw-class="space-y-2"><dt tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><CpuIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelDiscoveryPanel__memory_hint() }}</dt><dd data-testid="repository-preview-memory" tw-class="text-base tabular-nums text-gray-700 dark:text-gray-300">{{ memoryGiB === undefined ? lazyStrings.LlamaCppBrowserRepositoryPreview__not_estimated() : `${memoryGiB} GiB` }}</dd></div>
        </dl>
        <p v-if="memoryGiB !== undefined" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelDiscoveryPanel__memory_depends_on_context_and_settings() }}</p>
        <div tw-class="grid grid-cols-1 gap-y-2"><LlamaCppBrowserDownloadDestination layout="field" :view="downloadDestination.view" :disabled="blocked" :layout-file="{ repository: catalog.repository, path: mainPath }" /></div>
        <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
        <p v-else-if="saved.status === 'unavailable'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadDestination__reconnect_in_folder_settings() }}</p>
      </div>
      <div v-if="launch?.status === 'failed'" data-testid="discovery-messages" tw-class="mt-5 space-y-2"><p role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() }}</p><HuggingFaceDownloadFailureHint v-if="launch.problem === 'failed'"><LlamaCppBrowserLocalFileRecovery :disabled="blocked" :accept-local-input="undefined" /></HuggingFaceDownloadFailureHint></div>
      <CspMessageHint v-else-if="metadataStatus !== 'failed' && saved.status !== 'saved'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" tw-class="mt-5" />
    </div>
    <footer tw-class="shrink-0 space-y-3 border-t border-gray-100 bg-white px-5 pb-5 pt-4 dark:border-gray-800 dark:bg-gray-900 sm:px-8 sm:pb-6">
      <button type="button" data-testid="discovery-start" :disabled="blocked || target === undefined || persistence !== 'saved' || unavailable || downloadDestination.view.busy.value || (saved.status !== 'saved' && saved.status !== 'missing') || modelLaunchEntryState.status === 'checking'" :aria-busy="starting" tw-class="group relative flex min-h-16 w-full items-center justify-center rounded-2xl border border-blue-400/80 bg-white px-14 py-4 text-center text-base font-bold text-gray-800 transition-colors hover:border-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-default dark:border-blue-500/70 dark:bg-gray-800 dark:text-gray-200" @click="start">{{ lazyStrings.SHARED__run_in_your_browser() }}<span aria-hidden="true" tw-class="absolute right-3 grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-white dark:bg-blue-500"><Loader2Icon v-if="starting" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" /><ArrowRightIcon v-else tw-class="h-4 w-4" /></span></button>
      <p v-if="selectionTarget !== 'chat'" tw-class="text-center text-xs text-gray-500 dark:text-gray-400">{{ saved.status === 'saved' ? lazyStrings.ModelDiscoveryPanel__start_a_new_chat_with_the_saved_model() : lazyStrings.ModelDiscoveryPanel__prepare_this_model_in_a_new_chat() }}</p>
    </footer>
  </div>
</template>
