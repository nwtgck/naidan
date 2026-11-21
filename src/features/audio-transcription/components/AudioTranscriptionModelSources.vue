<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import ModelSelectorHuggingFaceSearch from '@/components/ModelSelectorHuggingFaceSearch.vue';
import LlamaCppBrowserDownloadDestination from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadDestination.vue';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { repositoryUrlPath } from '@/features/llama-cpp-browser/hugging-face/types';
import { confirmModelLaunchConfiguration, modelLaunchChoices } from '@/features/llama-cpp-browser/model-launch/target';
import type { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import { lazyStrings } from '@/strings';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import ModelSelectorVariantDownload from '@/components/ModelSelectorVariantDownload.vue';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { hasActiveRepositoryDefaultDownload, repositoryRowDownload, type RepositoryModelDownloadRequest } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import ModelSelectorConfigurationSummary from '@/components/ModelSelectorConfigurationSummary.vue';
import ModelSelectorConfiguration from '@/components/ModelSelectorConfiguration.vue';
import ModelSelectorFileOptions from '@/components/ModelSelectorFileOptions.vue';
import ModelSelectorRepositorySource from '@/components/ModelSelectorRepositorySource.vue';

const props = defineProps<{ models: ReturnType<typeof useAudioTranscriptionModels>, disabled: boolean, active: boolean, query: string, popupTarget?: HTMLElement }>();
const emit = defineEmits<{ selected: [], 'update:query': [value: string] }>();
const catalog = shallowRef<RepositoryCatalog>();
const search = ref<InstanceType<typeof ModelSelectorHuggingFaceSearch>>();
const openedRepository = shallowRef<{ repository: string, source: 'url' | 'result' }>();
const metadataRequest = shallowRef<AbortController>();
const choosingRepository = ref<string>();
const failed = ref(false);
const editingConfiguration = ref(false);
const draftVariant = ref<string>();
const preparingLabel = computed(() => lazyStrings.AudioTranscriptionModelSources__preparing_model());
const preparationFailureLabel = computed(() => lazyStrings.AudioTranscriptionModelSources__could_not_prepare_model());
const blocked = computed(() => props.disabled || props.models.busy.value || !props.active);

// ASR currently supports one complete GGUF, without shards or companions.
function recognitionChoices({ catalog }: { catalog: RepositoryCatalog }) {
  return modelLaunchChoices({ catalog }).filter(choice => choice.models.length === 1 && choice.models[0]?.files.length === 1);
}

function standardRecognitionVariant({ choices }: { choices: ReturnType<typeof recognitionChoices> }) {
  return choices.find(choice => choice.quantization === 'Q8_0') ?? choices[0];
}

const choices = computed(() => catalog.value === undefined ? [] : recognitionChoices({ catalog: catalog.value }));
const variants = computed(() => choices.value.map(choice => ({
  id: choice.primaryRelativePath,
  label: choice.quantization ?? choice.label,
  filePath: choice.primaryRelativePath,
  bytes: choice.models[0]?.size ?? 0,
})));
const standardVariant = computed(() => standardRecognitionVariant({ choices: choices.value })?.primaryRelativePath);
const currentVariant = computed(() => variants.value.find(variant => variant.id === draftVariant.value));
const selectedRepository = computed(() => {
  const selected = props.models.selectedDetails.value;
  switch (selected?.kind) {
  case 'huggingface': return selected.repository;
  case 'local': case undefined: return undefined;
  default: throw new Error(String(selected satisfies never));
  }
});
const selectedVariant = computed(() => {
  const selected = props.models.selectedDetails.value;
  return selected?.kind === 'huggingface' && selected.repository === catalog.value?.repository
    ? props.models.selectedQuantizationId.value
    : undefined;
});

function resetRepository(): void {
  metadataRequest.value?.abort();
  metadataRequest.value = undefined;
  choosingRepository.value = undefined;
  openedRepository.value = undefined;
  catalog.value = undefined;
  draftVariant.value = undefined;
  editingConfiguration.value = false;
  failed.value = false;
}

async function inspectRepository({ repository, source, action }: { repository: string, source: 'url' | 'result', action: 'details' | 'choose' }): Promise<void> {
  if (blocked.value || action === 'choose' && choosingRepository.value === repository) {
    return;
  }
  if (action === 'choose' && repository.toLowerCase() === selectedRepository.value?.toLowerCase()) {
    emit('selected');
    return;
  }
  if (action === 'choose' && catalog.value?.repository.toLowerCase() === repository.toLowerCase()) {
    useConfiguration({ id: draftVariant.value, presentation: 'close' });
    return;
  }
  if (action === 'details' && source === 'result' && openedRepository.value?.source === source && openedRepository.value.repository === repository) {
    closeRepository();
    return;
  }
  resetRepository();
  openedRepository.value = { repository, source };
  const controller = new AbortController();
  metadataRequest.value = controller;
  const chooseImmediately = (() => {
    switch (action) {
    case 'choose': return true;
    case 'details': return false;
    default: throw new Error(String(action satisfies never));
    }
  })();
  choosingRepository.value = chooseImmediately ? repository : undefined;
  try {
    // Only a submitted repository or an explicitly selected search result
    // authorizes this request. Typing and opening this panel stay local.
    const result = await awaitInspection({ task: getMetadataSession().inspect({ input: repository, signal: controller.signal, freshness: 'reuse' }), signal: controller.signal });
    controller.signal.throwIfAborted();
    catalog.value = result;
    const alreadySelected = selectedVariant.value;
    draftVariant.value = variants.value.some(variant => variant.id === alreadySelected) ? alreadySelected : standardVariant.value;
    if (chooseImmediately) {
      useConfiguration({ id: draftVariant.value, presentation: 'close' });
    }
  } catch {
    if (!controller.signal.aborted) {
      failed.value = true;
    }
  } finally {
    if (metadataRequest.value === controller) {
      metadataRequest.value = undefined;
      choosingRepository.value = undefined;
    }
  }
}

function closeRepository(): void {
  const opened = openedRepository.value;
  resetRepository();
  if (opened !== undefined) {
    void nextTick(() => search.value?.focusOrigin(opened));
  }
}

function handleEscape({ event }: { event: KeyboardEvent }): void {
  if (openedRepository.value !== undefined && !event.isComposing && !event.defaultPrevented) {
    event.stopPropagation();
    event.preventDefault();
    closeRepository();
  }
}

function targetForVariant({ id }: { id: string }) {
  const repository = catalog.value;
  if (repository !== undefined) {
    try {
      return confirmModelLaunchConfiguration({ catalog: repository, mainFilePath: id, companionFilePath: undefined, multimodal: 'off' });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function variantDownload({ id }: { id: string }): RepositoryModelDownloadRequest | undefined {
  const target = targetForVariant({ id });
  if (target === undefined) {
    return undefined;
  }
  const selection = target.selection;
  const destination = props.models.downloadDestination.destination.value;
  if (props.models.isInstalledAtDestination({ selection, destination })) {
    return undefined;
  }
  return {
    key: selectionKey({ selection }),
    repository: selection.repository,
    source: 'repository',
    destination,
    prepared: selection,
    prepare: async () => selection,
  };
}

function searchResultDownload({ repository }: { repository: string }): RepositoryModelDownloadRequest | undefined {
  const destination = props.models.downloadDestination.destination.value;
  if (!hasActiveRepositoryDefaultDownload({ repository, usage: 'transcription', destination })) {
    const selectedId = props.models.selectedId.value;
    const chosen = selectedId !== undefined && selectedRepository.value?.toLowerCase() === repository.toLowerCase()
      ? props.models.requestForId({ id: selectedId }) : undefined;
    if (chosen !== undefined) {
      return chosen.prepared !== undefined && props.models.isInstalledAtDestination({ selection: chosen.prepared, destination }) ? undefined : chosen;
    }
    if (catalog.value?.repository.toLowerCase() === repository.toLowerCase() && draftVariant.value !== undefined) {
      return variantDownload({ id: draftVariant.value });
    }
  }
  return repositoryRowDownload({
    repository,
    destination: props.models.downloadDestination.destination.value,
    usage: 'transcription',
    selection: undefined,
    defaultSelection: ({ catalog }) => {
      const variant = standardRecognitionVariant({ choices: recognitionChoices({ catalog }) });
      return confirmModelLaunchConfiguration({ catalog, mainFilePath: variant?.primaryRelativePath ?? '', companionFilePath: undefined, multimodal: 'off' }).selection;
    },
  });
}

function useConfiguration({ id, presentation }: { id: string | undefined, presentation: 'close' | 'keep-open' }): void {
  if (blocked.value || id === undefined) {
    return;
  }
  const selected = targetForVariant({ id });
  if (selected === undefined) {
    failed.value = true;
    return;
  }
  props.models.addRepositoryModel({ selection: selected.selection });
  draftVariant.value = id;
  switch (presentation) {
  case 'close': emit('selected');
    break;
  case 'keep-open': break;
  default: throw new Error(String(presentation satisfies never));
  }
}

watch(() => props.query, resetRepository);
watch(() => props.disabled || !props.active, value => {
  if (value) {
    resetRepository();
  }
});
onScopeDispose(resetRepository);
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="audio-transcription-model-sources" tw-class="space-y-4 text-left">
    <div @keydown.esc="handleEscape({ event: $event })">
      <ModelSelectorHuggingFaceSearch ref="search" :query="query" :active="props.active" :disabled="disabled || models.busy.value" :expanded-repository="openedRepository" immediate-selection :selected-repository="selectedRepository" :choosing-repository="choosingRepository" @update:query="emit('update:query', $event)" @select="(repository, source) => inspectRepository({ repository, source, action: 'details' })" @choose="repository => inspectRepository({ repository, source: 'result', action: 'choose' })" @search="resetRepository">
        <template #result-actions="{ repository }">
          <ModelSelectorVariantDownload :destination-label="models.downloadDestination.label" :request="searchResultDownload({ repository })" :label="repository" :refresh-inventory="models.refresh" :disabled="blocked || models.downloadDestination.unavailable.value || models.downloadDestination.view.busy.value" />
        </template>
        <template #repository>
          <ModelSelectorConfiguration v-if="openedRepository" @collapse="closeRepository">
            <template v-if="currentVariant && !failed" #summary>
              <ModelSelectorConfigurationSummary :status="draftVariant === standardVariant ? 'standard' : 'selected'" :quantization="currentVariant.label" :bytes="currentVariant.bytes" :expanded="editingConfiguration" selectable :checked="draftVariant === selectedVariant" :selection-disabled="blocked" @toggle="editingConfiguration = !editingConfiguration" @choose="useConfiguration({ id: draftVariant, presentation: 'close' })" />
            </template>
            <template v-if="catalog && editingConfiguration && !failed && !metadataRequest" #source>
              <ModelSelectorRepositorySource :repository="catalog.repository" :url="'https://huggingface.co/' + repositoryUrlPath({ repository: catalog.repository })" />
            </template>
            <p v-if="metadataRequest" role="status" tw-class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ lazyStrings.AudioTranscriptionModelSources__checking_repository() }}</p>
            <p v-else-if="failed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.AudioTranscriptionModelSources__could_not_check_repository() }}</p>
            <template v-else-if="catalog">
              <div v-if="currentVariant" tw-class="space-y-2">
                <ModelSelectorFileOptions v-if="editingConfiguration" test-id="audio-transcription-model-variant" :model-name="catalog.repository" :choices="variants" :selected="draftVariant" :disabled="blocked" @select="useConfiguration({ id: $event, presentation: 'keep-open' })">
                  <template #action="{ choice }"><ModelSelectorVariantDownload :request="variantDownload({ id: choice.id })" :label="choice.label" :refresh-inventory="models.refresh" :disabled="blocked || models.downloadDestination.unavailable.value || models.downloadDestination.view.busy.value" /></template>
                </ModelSelectorFileOptions>
                <LlamaCppBrowserDownloadDestination :view="models.downloadDestination.view" :disabled="blocked" :layout-file="{ repository: catalog.repository, path: currentVariant.filePath }" :popup-target="popupTarget" layout="compact" />
              </div>
              <p v-else role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.AudioTranscriptionModelSources__no_single_file_models() }}</p>
            </template>
          </ModelSelectorConfiguration>
        </template>
      </ModelSelectorHuggingFaceSearch>
    </div>
    <p v-if="models.busy.value" role="status" tw-class="text-sm text-gray-500 dark:text-gray-400">{{ preparingLabel }}</p>
    <p v-if="models.failure.value" role="alert" tw-class="text-sm text-red-600 dark:text-red-400">{{ preparationFailureLabel }}</p>
  </div>
</template>
