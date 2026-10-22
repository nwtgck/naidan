<script setup lang="ts">
import { computed, defineAsyncComponent, onScopeDispose, ref, watch } from 'vue';
import { FolderInputIcon } from 'lucide-vue-next';
import BrowserModelWelcome from '@/components/BrowserModelWelcome.vue';
import LlamaCppBrowserModelLaunchEntry from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue';
import { browserModelSuggestionSelection, type BrowserModelLocalInput } from '@/components/browser-model-presentation';
import { useAppEntry } from '@/composables/useAppEntry';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { useToast } from '@/composables/useToast';
import { modelLaunchEntryState, startModelLaunch } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { captureDroppedLocalModels } from '@/features/llama-cpp-browser/logic/local-model-input';
import { ensureStrings, lazyStrings } from '@/strings';

const entry = useAppEntry();
const { addToast } = useToast();
const localInputOpened = ref(false);
const dragVisibility = ref<'hidden' | 'visible'>('hidden');
const LocalModelSelectionDialog = defineAsyncComponent(() => import('@/components/LocalModelSelectionDialog.vue'));
const localInputs = new Set<{ context: ReturnType<typeof entry.captureModelLaunchStartContext>, controller: AbortController }>();
const modelInput = computed(() => {
  const intent = entry.intent.value;
  const kind = intent.kind;
  switch (kind) {
  case 'model-preview':
    return intent.input;
  case 'home':
  case 'ordinary':
  case 'pending':
    break;
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'needs-selection': {
    const selected = browserModelSuggestionSelection({ selection: entry.homeSelection.value });
    const variant = selected?.quantization.preferredQuantization;
    return `${state.input}${variant === undefined ? '' : `:${variant}`}`;
  }
  case 'idle':
  case 'checking':
  case 'failed':
    return undefined;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});
const showModelPreview = computed(() => {
  const kind = entry.intent.value.kind;
  switch (kind) {
  case 'model-preview':
    return true;
  case 'home':
  case 'ordinary':
  case 'pending':
    break;
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'needs-selection':
    return true;
  case 'idle':
  case 'checking':
  case 'failed':
    return false;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});
const startStatus = computed(() => {
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'checking':
    return 'starting' as const;
  case 'idle':
  case 'needs-selection':
  case 'failed':
    return 'idle' as const;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});
const startError = computed(() => {
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'failed':
    return lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model();
  case 'idle':
  case 'checking':
  case 'needs-selection':
    return undefined;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
});

function selectModel({ suggestionId, quantizationId }: { suggestionId: string, quantizationId: string | undefined }): void {
  const interaction = entry.interaction.value;
  switch (interaction) {
  case 'ready':
    entry.homeSelection.value = { suggestionId, quantizationId };
    return;
  case 'blocked':
    return;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
}

function start(): void {
  const interaction = entry.interaction.value;
  switch (interaction) {
  case 'blocked':
    return;
  case 'ready':
    break;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
  const selected = browserModelSuggestionSelection({ selection: entry.homeSelection.value });
  if (selected === undefined) {
    return;
  }
  startModelLaunch({
    request: {
      input: selected.quantization.hfRepository,
      requestedVariant: selected.quantization.preferredQuantization,
      multimodal: 'auto',
      destination: { kind: 'opfs' },
      source: 'home',
    },
  });
}

async function handleLocalInput({ directories, controller }: { directories: BrowserModelLocalInput['directories'], controller: AbortController }): Promise<void> {
  // Capture failures may settle before the action's lazy command is available.
  void directories.catch(() => {});
  const interaction = entry.interaction.value;
  switch (interaction) {
  case 'blocked':
    controller.abort();
    return;
  case 'ready':
    break;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
  const context = entry.captureModelLaunchStartContext();
  const operation = { context, controller };
  localInputs.add(operation);
  localInputOpened.value = true;
  try {
    const module = await import('@/composables/useLocalModelStart');
    if (!context.isCurrent()) {
      controller.abort();
      return;
    }
    await module.startLocalModelInput({ directories, controller, context });
  } catch (error) {
    if (!controller.signal.aborted && context.isCurrent()) {
      console.error('[AppEntrySurface] Could not open local model:', error);
      const message = await ensureStrings.AppEntrySurface__could_not_open_local_model();
      if (!controller.signal.aborted && context.isCurrent()) {
        addToast({ message });
      }
    }
  } finally {
    localInputs.delete(operation);
  }
}

function dragOver({ event }: { event: DragEvent }): void {
  if (entry.intent.value.kind !== 'home' || entry.interaction.value !== 'ready' || startStatus.value === 'starting' || showModelPreview.value || !event.dataTransfer?.types.includes('Files')) {
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  dragVisibility.value = 'visible';
}

function dragLeave({ event }: { event: DragEvent }): void {
  if (!(event.currentTarget instanceof HTMLElement)) {
    return;
  }
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) {
    dragVisibility.value = 'hidden';
  }
}

function dropFiles({ event }: { event: DragEvent }): void {
  dragVisibility.value = 'hidden';
  if (entry.intent.value.kind !== 'home' || entry.interaction.value !== 'ready' || startStatus.value === 'starting' || showModelPreview.value || !event.dataTransfer?.types.includes('Files')) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const controller = new AbortController();
  // File-system entries must be captured before the drop dispatch returns.
  const directories = captureDroppedLocalModels({ transfer: event.dataTransfer, signal: controller.signal });
  void handleLocalInput({ directories, controller });
}

useEventTargetListener(window, 'blur', () => {
  dragVisibility.value = 'hidden';
});
useEventTargetListener(document, 'dragend', () => {
  dragVisibility.value = 'hidden';
});
useEventTargetListener(document, 'keydown', event => {
  if (event.key === 'Escape') {
    dragVisibility.value = 'hidden';
  }
});
watch([entry.intent, entry.interaction, startStatus], () => {
  dragVisibility.value = 'hidden';
});

watch(entry.intent, () => {
  for (const operation of localInputs) {
    if (!operation.context.isCurrent()) {
      operation.controller.abort();
    }
  }
}, { flush: 'sync' });
onScopeDispose(() => {
  for (const operation of localInputs) {
    if (!operation.context.isCurrent()) {
      operation.controller.abort();
    }
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="app-entry-surface" :inert="entry.interaction.value === 'blocked' || undefined" :aria-busy="entry.interaction.value === 'blocked'" tw-class="relative h-full min-h-0 overflow-hidden bg-[#fcfcfd] dark:bg-gray-900" @dragover="dragOver({ event: $event })" @dragleave="dragLeave({ event: $event })" @drop="dropFiles({ event: $event })" @dragend="dragVisibility = 'hidden'">
    <div v-if="dragVisibility === 'visible'" data-testid="model-drop-overlay" tw-class="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 pointer-events-none flex items-center justify-center">
      <div class="model-drop-card" tw-class="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-xl dark:bg-gray-800"><FolderInputIcon aria-hidden="true" tw-class="h-6 w-6 text-blue-500" /><span tw-class="text-lg font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.AppEntrySurface__drop_gguf_files_or_model_folders() }}</span></div>
    </div>
    <div tw-class="h-full min-h-0 overflow-auto">
      <LlamaCppBrowserModelLaunchEntry v-if="showModelPreview" :input="modelInput" :interaction="entry.interaction.value" :operation="modelLaunchEntryState.status === 'needs-selection' ? modelLaunchEntryState.operation : undefined" />
      <BrowserModelWelcome
        v-else-if="entry.intent.value.kind === 'home'"
        :interaction="entry.interaction.value"
        :selection="entry.homeSelection.value"
        :start-status="startStatus"
        :start-error="startError"
        @select="selectModel"
        @start="start"
        @open-discovery="entry.openDiscovery"
        @local-input="handleLocalInput"
      />
      <LocalModelSelectionDialog v-if="localInputOpened" />
    </div>
  </div>
</template>

<style scoped>
.model-drop-card {
  animation: model-drop-appear 200ms ease-out;
}
@keyframes model-drop-appear {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .model-drop-card {
    animation: none;
  }
}
</style>
