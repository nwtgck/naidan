<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { useAppEntry } from '@/composables/useAppEntry';
import { usePageDocumentMetadata } from '@/composables/useDocumentMetadata';
import { modelLaunchMetadata } from '@/features/llama-cpp-browser/model-launch/document-metadata';
import { modelLaunchPresentation } from '@/features/llama-cpp-browser/model-launch/presentation';
import { confirmModelLaunchSelection, modelLaunchEntryState, retireModelLaunch, retryModelLaunch, startModelLaunch } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { quantizationChoices, selectedQuantizationChoice } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { artifactRole } from '@/features/llama-cpp-browser/hugging-face/artifact-role';
import LlamaCppBrowserQuantizationPicker from './LlamaCppBrowserQuantizationPicker.vue';
import WelcomeScreenFrame from '@/components/layout/WelcomeScreenFrame.vue';
import LanguageSelector from '@/components/LanguageSelector.vue';
import ThemeToggle from '@/features/theme/components/ThemeToggle.vue';
import { browserModelRepositoryPresentation } from '@/components/browser-model-presentation';
import BrowserModelPreparation from '@/components/BrowserModelPreparation.vue';

const props = defineProps<{ input?: string | (string | null)[] | null, interaction?: 'blocked' | 'ready', operation?: symbol }>();
const appEntry = useAppEntry();
const localOperation = ref<symbol>();
const inspectedCatalog = shallowRef<RepositoryCatalog>();
const repairInput = ref(typeof props.input === 'string' ? props.input : '');
const repairInputId = useId();
const originalPresentation = computed(() => modelLaunchPresentation({ input: props.input }));
const presentation = computed(() => originalPresentation.value ?? modelLaunchPresentation({ input: repairInput.value }));
const metadataInspection = computed(() => {
  const intent = appEntry.intent.value;
  const kind = intent.kind;
  switch (kind) {
  case 'model-preview':
    // Privacy exception: visiting #/?llama-cpp-browser-model=... authorizes
    // metadata for that repository on entry. It does not authorize downloads,
    // chat/group creation, or background discovery on ordinary home screens.
    // A repaired input still requires an action instead of fetching per keystroke.
    return intent.routePath === '/' && originalPresentation.value !== undefined ? 'model-url' : 'on-request';
  case 'pending': case 'home': case 'ordinary': return 'on-request';
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
});
const entryOwner = computed(() => {
  const intent = appEntry.intent.value;
  switch (intent.kind) {
  case 'pending': return undefined;
  case 'home': case 'model-preview': case 'ordinary': return intent.owner;
  default: {
    const exhaustive: never = intent;
    return exhaustive;
  }
  }
});
watch([() => props.input, entryOwner], () => {
  repairInput.value = typeof props.input === 'string' ? props.input : '';
  localOperation.value = undefined;
  inspectedCatalog.value = undefined;
});
const repository = computed(() => presentation.value?.repository ?? '');
const requestedVariant = computed(() => {
  const selection = appEntry.previewVariantSelection.value;
  switch (selection.kind) {
  case 'initial': return presentation.value?.requestedVariant;
  case 'selected': return selection.requestedVariant;
  default: {
    const exhaustive: never = selection;
    return exhaustive;
  }
  }
});
const suggestion = computed(() => modelSuggestions.find(candidate => candidate.quantizationHints.some(hint => hint.hfRepository.toLowerCase() === repository.value.toLowerCase())));
const hints = computed(() => suggestion.value?.quantizationHints.filter(hint => hint.hfRepository.toLowerCase() === repository.value.toLowerCase()) ?? []);
const selectedHint = computed(() => requestedVariant.value === undefined ? hints.value[0]
  : hints.value.find(hint => hint.preferredQuantization.toUpperCase() === requestedVariant.value?.toUpperCase()));
const inspectedChoices = computed(() => {
  const catalog = inspectedCatalog.value;
  if (catalog === undefined || catalog.repository.toLowerCase() !== repository.value.toLowerCase()) {
    return [];
  }
  return quantizationChoices({ repository: catalog.repository, models: catalog.models }).filter(choice => artifactRole({ path: choice.primaryRelativePath }) === 'model');
});
const displayedVariant = computed(() => {
  const selected = requestedVariant.value ?? inspectedChoices.value[0]?.primaryRelativePath;
  if (selected !== undefined) {
    return selected;
  }
  const inspection = metadataInspection.value;
  switch (inspection) {
  case 'model-url': return undefined;
  case 'on-request': return selectedHint.value?.preferredQuantization;
  default: {
    const exhaustive: never = inspection;
    throw new Error(String(exhaustive));
  }
  }
});
const checkedSize = computed(() => selectedQuantizationChoice({ choices: inspectedChoices.value, variant: displayedVariant.value })?.models.reduce((total, model) => total + model.size, 0));
const model = computed(() => browserModelRepositoryPresentation({ repository: repository.value, bytes: inspectedCatalog.value === undefined ? selectedHint.value?.approximateModelBytes : checkedSize.value }));
const state = computed(() => {
  const current = modelLaunchEntryState.value;
  switch (current.status) {
  case 'idle': return undefined;
  case 'checking': case 'needs-selection': case 'failed':
    return current.operation === (localOperation.value ?? props.operation) ? current : undefined;
  default: {
    const exhaustive: never = current;
    return exhaustive;
  }
  }
});
const selectionState = computed(() => {
  const current = state.value;
  if (current === undefined) {
    return undefined;
  }
  switch (current.status) {
  case 'checking': case 'failed': return undefined;
  case 'needs-selection': return current;
  default: {
    const exhaustive: never = current;
    return exhaustive;
  }
  }
});
const stage = computed(() => {
  const current = state.value;
  if (current === undefined) {
    return presentation.value === undefined ? 'failed' : 'preview';
  }
  switch (current.status) {
  case 'checking': return 'checking';
  case 'needs-selection': return 'needs-selection';
  case 'failed': return 'failed';
  default: {
    const exhaustive: never = current;
    return exhaustive;
  }
  }
});
const error = computed(() => {
  if (!presentation.value) {
    return lazyStrings.LlamaCppBrowserModelLaunch__model_link_could_not_be_opened();
  }
  const current = state.value;
  if (current === undefined) {
    return undefined;
  }
  switch (current.status) {
  case 'checking': case 'needs-selection': return undefined;
  case 'failed':
    switch (current.problem) {
    case 'variant-unavailable': return lazyStrings.LlamaCppBrowserModelLaunch__variant_not_found();
    case 'companion-required': return lazyStrings.LlamaCppBrowserModelLaunch__companion_needs_selection();
    case 'invalid-input': case 'failed': return lazyStrings.LlamaCppBrowserModelLaunch__model_link_could_not_be_opened();
    default: {
      const exhaustive: never = current.problem;
      return exhaustive;
    }
    }
  default: {
    const exhaustive: never = current;
    return exhaustive;
  }
  }
});
const interaction = computed(() => props.interaction ?? appEntry.interaction.value);
usePageDocumentMetadata({
  source: computed(() => {
    if (presentation.value === undefined) {
      return undefined;
    }
    const intent = appEntry.intent.value;
    let routePath: string;
    switch (intent.kind) {
    case 'pending': routePath = '/';
      break;
    case 'home': case 'model-preview': case 'ordinary': routePath = intent.routePath;
      break;
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
    }
    return { routePath, metadata: modelLaunchMetadata({ repository: repository.value, variant: requestedVariant.value }) };
  }),
});

function selectVariant({ value }: { value: string }): void {
  if (state.value) {
    retireModelLaunch({ operation: state.value.operation });
  }
  localOperation.value = undefined;
  appEntry.previewVariantSelection.value = { kind: 'selected', requestedVariant: value.trim() || undefined };
}

function repairRepository({ event }: { event: Event }): void {
  const currentInteraction = interaction.value;
  switch (currentInteraction) {
  case 'blocked': return;
  case 'ready': break;
  default: {
    const exhaustive: never = currentInteraction;
    throw new Error(String(exhaustive));
  }
  }
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  if (state.value !== undefined) {
    retireModelLaunch({ operation: state.value.operation });
  }
  localOperation.value = undefined;
  repairInput.value = event.target.value;
  appEntry.previewVariantSelection.value = { kind: 'initial' };
}

function start(): void {
  const currentInteraction = interaction.value;
  switch (currentInteraction) {
  case 'blocked': return;
  case 'ready': break;
  default: {
    const exhaustive: never = currentInteraction;
    throw new Error(String(exhaustive));
  }
  }
  if (!presentation.value) {
    return;
  }
  const current = state.value;
  if (current !== undefined) {
    switch (current.status) {
    case 'checking': case 'needs-selection': return;
    case 'failed': retryModelLaunch();
      return;
    default: {
      const exhaustive: never = current;
      throw new Error(String(exhaustive));
    }
    }
  }
  localOperation.value = startModelLaunch({ request: { input: originalPresentation.value === undefined ? repairInput.value.trim() : repository.value, requestedVariant: displayedVariant.value, multimodal: 'auto', destination: { kind: 'opfs' }, source: 'model-url' } });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="model-launch-entry" tw-class="relative flex-1 min-h-0 overflow-y-auto overscroll-contain bg-[#fcfcfd] dark:bg-gray-900">
    <div :inert="interaction !== 'ready' || undefined" data-testid="model-entry-language" tw-class="absolute right-4 top-4 z-20 flex items-center gap-2 pointer-events-auto sm:right-6 sm:top-6">
      <div tw-class="w-24 shrink-0 sm:w-28"><ThemeToggle /></div>
      <LanguageSelector />
    </div>
    <WelcomeScreenFrame class="model-url-entry-welcome" placement="contained">
      <div tw-class="w-full max-w-lg space-y-5">
        <section v-if="originalPresentation === undefined" :inert="interaction === 'blocked' || undefined" data-testid="model-link-repair" tw-class="space-y-3 text-left pointer-events-auto">
          <h2 tw-class="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchEntry__check_the_model_link() }}</h2>
          <label :for="repairInputId" tw-class="block text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.LlamaCppBrowserModelLaunchEntry__repository_or_hugging_face_model_url() }}</label>
          <input :id="repairInputId" :value="repairInput" type="text" :disabled="interaction === 'blocked' || stage === 'checking'" :placeholder="lazyStrings.LlamaCppBrowserModelLaunchEntry__enter_owner_model_or_a_model_page_url()" data-testid="model-link-repository-input" tw-class="block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" @input="repairRepository({ event: $event })" />
          <p v-if="presentation === undefined" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ error }}</p>
        </section>
        <BrowserModelPreparation v-if="presentation" :model="model" entry="model-url" :stage="stage" :interaction="interaction" :variant="displayedVariant" :quantization-options="[]" :start-status="state?.status === 'checking' ? 'starting' : 'idle'" :error="error" :selection-state="selectionState" @start="start" @select-quantization="selectVariant({ value: $event })" @confirm-selection="confirmModelLaunchSelection($event)">
          <template #quantization="{ disabled }"><LlamaCppBrowserQuantizationPicker :key="entryOwner" :repository="repository" :variant="displayedVariant" :disabled="disabled" :inspection="metadataInspection" @select="selectVariant({ value: $event })" @inspected="inspectedCatalog = $event" /></template>
        </BrowserModelPreparation>
      </div>
    </WelcomeScreenFrame>
  </div>
</template>

<style scoped>
.model-url-entry-welcome {
  justify-content: flex-start;
  padding-top: clamp(72px, 13dvh, 120px);
  padding-bottom: 24px;
}
</style>
