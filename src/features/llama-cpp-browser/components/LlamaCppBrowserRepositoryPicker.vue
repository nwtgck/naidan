<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, HardDriveIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { installedSelection } from '@/features/llama-cpp-browser/hugging-face/storage';
import { formatDownloadBytes, preferredProjector } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { confirmModelLaunchConfiguration, modelLaunchChoices, resolveModelLaunchConfiguration } from '@/features/llama-cpp-browser/model-launch/target';
import LlamaCppBrowserModelConfiguration from './LlamaCppBrowserModelConfiguration.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
import LlamaCppBrowserHuggingFaceSearch from './LlamaCppBrowserHuggingFaceSearch.vue';

const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ select: [target: ModelLaunchTarget] }>();
const id = useId();
const input = ref('');
const catalog = shallowRef<RepositoryCatalog>();
const active = shallowRef<AbortController>();
const error = ref(false);
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
const saved = ref<'checking' | 'saved' | 'missing'>('checking');
watch(target, async (value, _previous, onCleanup) => {
  let current = true;
  onCleanup(() => {
    current = false;
  });
  saved.value = 'checking';
  if (value === undefined) {
    return;
  }
  try {
    const model = await installedSelection({ selection: value.selection, destination: { kind: 'opfs' } });
    if (current) {
      saved.value = model === undefined ? 'missing' : 'saved';
    }
  } catch {
    if (current) {
      saved.value = 'missing';
    }
  }
});

function reset(): void {
  active.value?.abort();
  active.value = undefined;
  catalog.value = undefined;
  error.value = false;
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
  try {
    const parsed = parseRepository({ input: value });
    // This explicit repository/search-result action authorizes metadata only.
    const found = await getMetadataSession().inspect({ input: value, signal: controller.signal, freshness: 'reuse' });
    if (controller.signal.aborted || active.value !== controller) {
      return;
    }
    catalog.value = found;
    const configuration = resolveModelLaunchConfiguration({ input: value, requestedVariant: parsed.requestedVariant, catalog: found, multimodal: 'auto' });
    const available = modelLaunchChoices({ catalog: found });
    switch (configuration.status) {
    case 'resolved':
      mainPath.value = configuration.target.mainFilePath;
      companionPath.value = found.projectors.find(file => configuration.target.selection.files.some(selected => selected.path === file.path))?.path ?? '';
      break;
    case 'needs-selection':
      mainPath.value = configuration.selectedMainPath ?? configuration.mainChoices[0]?.path ?? '';
      companionPath.value = configuration.selectedCompanionPath ?? '';
      break;
    case 'invalid':
      mainPath.value = available[0]?.primaryRelativePath ?? '';
      companionPath.value = '';
      error.value = available.length === 0;
      break;
    default: {
      const exhaustive: never = configuration;
      throw new Error(String(exhaustive));
    }
    }
    // Match settings: enable available multimodal support and prefer only an
    // unambiguous companion. Different projector families need a real choice.
    multimodal.value = found.projectors.length > 0 ? 'on' : 'off';
    companionPath.value ||= preferredProjector({ files: found.projectors })?.path ?? '';
  } catch {
    if (!controller.signal.aborted) {
      error.value = true;
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
        <button type="button" data-testid="chat-model-repository-check" :disabled="disabled || !input.trim() || active !== undefined" tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs font-medium text-blue-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-blue-400 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="checkRepository({ value: input })"><Loader2Icon v-if="active" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__check_repository() }}</button>
      </div>
    </div>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__could_not_check_repository() }}</p>
    <section v-if="catalog" data-testid="chat-model-configuration" tw-class="space-y-4">
      <div tw-class="space-y-2">
        <button type="button" data-testid="chat-model-back-to-search" :disabled="disabled" tw-class="group -ml-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100" @click="catalog = undefined"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__back_to_search() }}</button>
        <p data-testid="chat-model-repository-name" tw-class="break-words text-sm font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ catalog.repository }}</p>
      </div>
      <LlamaCppBrowserModelConfiguration v-model:quantization="mainPath" v-model:multimodal="multimodal" v-model:projector="companionPath" :choices="choices" :projectors="catalog.projectors" :disabled="disabled" :multimodal-description-id="undefined" />
      <div tw-class="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3 dark:border-gray-800">
        <div tw-class="flex flex-wrap items-center gap-2.5">
          <span v-if="bytes !== undefined" data-testid="chat-model-download-size" tw-class="inline-flex items-center gap-1.5 text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300"><HardDriveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />{{ formatDownloadBytes({ bytes }) }}</span>
          <span v-if="saved === 'saved'" tw-class="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserRepositoryPicker__saved() }}</span>
        </div>
        <LlamaCppBrowserModelActionButton data-testid="chat-use-repository-model" :disabled="disabled || target === undefined || saved === 'checking'" tw-class="ml-auto" @click="target && emit('select', target)">{{ lazyStrings.SHARED__use_model_in_this_chat() }}<ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transform-none" /></LlamaCppBrowserModelActionButton>
      </div>
      <p v-if="saved === 'missing'" tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRepositoryPicker__this_model_will_be_saved_in_your_browser() }}</p>
    </section>
    <LlamaCppBrowserHuggingFaceSearch v-show="catalog === undefined" :disabled="disabled || active !== undefined || catalog !== undefined" :repository-input="input" @select="checkRepository({ value: $event })" />
  </div>
</template>
