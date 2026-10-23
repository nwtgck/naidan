<script setup lang="ts">
import { computed, markRaw, nextTick, onScopeDispose, ref, shallowRef, watch, type Component } from 'vue';
import { FolderInputIcon } from 'lucide-vue-next';
import BrowserModelDialog from './BrowserModelDialog.vue';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import { browserModelRepositoryPresentation, browserModelSuggestionSelection, type BrowserModelLocalInput } from './browser-model-presentation';
import { useAppEntry } from '@/composables/useAppEntry';
import { useToast } from '@/composables/useToast';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { confirmModelLaunchSelection, modelLaunchEntryState, retireModelLaunch, retryModelLaunch, startModelLaunch, type ModelLaunchEntryState } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { captureDroppedLocalModels } from '@/features/llama-cpp-browser/logic/local-model-input';
import { waitForPresentationPaint } from '@/logic/startup/presentation-frame';
import { createModuleLoader } from '@/utils/module-loader';
import { scheduleIdleTask, type ScheduledIdleTask } from '@/utils/idle-task';
import { ensureStrings, lazyStrings } from '@/strings';

// The initial dialog and its cards are synchronous. Only action-owned views
// are deferred, with optional UI prefetch after the initial paint opportunity.
const fileSelectionLoader = createModuleLoader({ importModule: () => import('./BrowserModelFileSelection.vue'), onPrefetchError: () => {} });
const FileSelection = shallowRef<Component>();
// This dialog imports the local-input workflow, so load it only on a file action.
const localSelectionLoader = createModuleLoader({ importModule: () => import('./LocalModelSelectionDialog.vue'), onPrefetchError: () => {} });
const LocalModelSelectionDialog = shallowRef<Component>();
const entry = useAppEntry();
const { addToast } = useToast();
const operation = ref<symbol>();
const files = shallowRef<Extract<ModelLaunchEntryState, { status: 'needs-selection' }>>();
const dragVisibility = ref<'hidden' | 'visible'>('hidden');
const localInputOpened = ref(false);
const loadingFiles = ref<symbol>();
const loadError = ref(false);
const localInputs = new Set<{ context: ReturnType<typeof entry.captureModelLaunchStartContext>, controller: AbortController }>();
let prefetch: ScheduledIdleTask | undefined;
let disposed = false;
const selection = computed(() => entry.modelSelection.value?.selection ?? entry.homeSelection.value);
const state = computed(() => {
  const current = modelLaunchEntryState.value;
  return current.status !== 'idle' && current.operation === operation.value ? current : undefined;
});
const busy = computed(() => state.value?.status === 'checking' || (operation.value !== undefined && loadingFiles.value === operation.value));
const error = computed(() => state.value?.status === 'failed' || loadError.value ? lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() : undefined);
const fileModel = computed(() => browserModelRepositoryPresentation({ repository: files.value?.input ?? '', bytes: undefined }));
const open = computed(() => entry.modelSelection.value?.phase === 'open');
const dismissible = computed(() => !(state.value?.status === 'checking' && state.value.phase === 'opening-chat'));
const canDrop = computed(() => open.value && entry.interaction.value === 'ready' && !busy.value && files.value === undefined);

watch(modelLaunchEntryState, async current => {
  if (current.status === 'needs-selection' && current.operation === operation.value) {
    loadingFiles.value = current.operation;
    try {
      const module = await fileSelectionLoader.load();
      if (!disposed && current === modelLaunchEntryState.value && open.value) {
        FileSelection.value = markRaw(module.default);
        files.value = current;
      }
    } catch {
      if (current === modelLaunchEntryState.value && open.value) {
        loadError.value = true;
      }
    } finally {
      if (loadingFiles.value === current.operation) {
        loadingFiles.value = undefined;
      }
    }
  }
});
watch(() => entry.modelSelection.value?.target, (target, previous) => {
  if (target !== undefined && target !== previous) {
    retire();
    files.value = undefined;
  }
});

watch(entry.interaction, async interaction => {
  switch (interaction) {
  case 'blocked': prefetch?.cancel();
    return;
  case 'ready': break;
  default: {
    const exhaustive: never = interaction;
    throw new Error(String(exhaustive));
  }
  }
  await nextTick();
  await waitForPresentationPaint({ window });
  if (!disposed && open.value && entry.interaction.value === 'ready') {
    prefetch = scheduleIdleTask({ task: () => fileSelectionLoader.prefetch(), timeoutMs: 1500, fallbackDelayMs: 200 });
  }
}, { immediate: true });
onScopeDispose(() => {
  disposed = true;
  prefetch?.cancel();
  // Accepted launches outlive their presentation while they open the chat and
  // enqueue its download. Only an unfinished choice belongs to this component.
  const current = state.value;
  if (current !== undefined && !(current.status === 'checking' && current.phase === 'opening-chat')) {
    retire();
  }
  for (const input of localInputs) {
    if (!input.context.isCurrent()) {
      input.controller.abort();
    }
  }
});

function retire(): void {
  if (operation.value !== undefined) {
    retireModelLaunch({ operation: operation.value });
    operation.value = undefined;
  }
}

function close(): void {
  if (dismissible.value) {
    retire();
    for (const input of localInputs) {
      input.controller.abort();
    }
    entry.closeModelSelection();
  }
}

function back(): void {
  retire();
  files.value = undefined;
}

function start(): void {
  if (!open.value || entry.interaction.value !== 'ready' || busy.value) {
    return;
  }
  const selected = browserModelSuggestionSelection({ selection: selection.value });
  if (selected !== undefined) {
    loadError.value = false;
    files.value = undefined;
    operation.value = startModelLaunch({ request: { input: selected.quantization.hfRepository, requestedVariant: selected.quantization.preferredQuantization, multimodal: 'auto', destination: { kind: 'opfs' }, source: 'home' } });
  }
}

function confirm({ mainFilePath, companionFilePath, multimodal }: { mainFilePath: string, companionFilePath: string | undefined, multimodal: 'on' | 'off' }): void {
  if (open.value && files.value !== undefined && entry.interaction.value === 'ready' && !busy.value) {
    confirmModelLaunchSelection({ operation: files.value.operation, mainFilePath, companionFilePath, multimodal });
  }
}

async function localInput({ directories, controller }: { directories: BrowserModelLocalInput['directories'], controller: AbortController }): Promise<void> {
  void directories.catch(() => {});
  const selection = entry.modelSelection.value;
  if (entry.interaction.value !== 'ready' || selection?.phase !== 'open') {
    controller.abort();
    return;
  }
  const target = selection.target;
  switch (target.kind) {
  case 'chat':
    target.acceptFiles({ directories, controller });
    entry.closeModelSelection();
    return;
  case 'home': break;
  default: {
    const exhaustive: never = target;
    throw new Error(String(exhaustive));
  }
  }
  const context = entry.captureModelLaunchStartContext();
  const input = { context, controller };
  localInputs.add(input);
  try {
    const dialog = await localSelectionLoader.load();
    if (!context.isCurrent() || !open.value) {
      controller.abort();
      return;
    }
    LocalModelSelectionDialog.value = markRaw(dialog.default);
    localInputOpened.value = true;
    const module = await import('@/composables/useLocalModelStart');
    if (!context.isCurrent() || !open.value) {
      controller.abort();
      return;
    }
    await module.startLocalModelInput({ directories, controller, context });
  } catch (error) {
    if (!controller.signal.aborted && context.isCurrent()) {
      console.error('[BrowserModelWelcomeDialog] Could not open local model:', error);
      const message = await ensureStrings.AppEntrySurface__could_not_open_local_model();
      if (!controller.signal.aborted && context.isCurrent()) {
        addToast({ message });
      }
    }
  } finally {
    localInputs.delete(input);
  }
}

function dragOver({ event }: { event: DragEvent }): void {
  if (canDrop.value && event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    dragVisibility.value = 'visible';
  }
}

function dragLeave({ event }: { event: DragEvent }): void {
  if (event.currentTarget instanceof HTMLElement) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) {
      dragVisibility.value = 'hidden';
    }
  }
}

function drop({ event }: { event: DragEvent }): void {
  dragVisibility.value = 'hidden';
  if (canDrop.value && event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    event.stopPropagation();
    const controller = new AbortController();
    // Native handles must be captured during dispatch, before any lazy import.
    const directories = captureDroppedLocalModels({ transfer: event.dataTransfer, signal: controller.signal });
    void localInput({ directories, controller });
  }
}

useEventTargetListener(window, 'blur', () => {
  dragVisibility.value = 'hidden';
});
useEventTargetListener(document, 'dragend', () => {
  dragVisibility.value = 'hidden';
});
watch([open, entry.interaction, busy], () => {
  dragVisibility.value = 'hidden';
});
watch(entry.intent, () => {
  for (const input of localInputs) {
    if (!input.context.isCurrent()) {
      input.controller.abort();
    }
  }
}, { flush: 'sync' });

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <BrowserModelDialog :open="open" :dismissible="dismissible" :suspended="entry.discovery.value !== undefined" @close="close" @closed="entry.finishModelSelectionClose">
    <Transition name="browser-model-step" mode="out-in">
      <FileSelection v-if="files" key="files" :model="fileModel" :selection="files" :busy="entry.interaction.value !== 'ready' || busy" :error="error" :action="state?.status === 'failed' ? 'retry' : 'confirm'" @back="back" @confirm="confirm" @retry="retryModelLaunch" />
      <BrowserModelWelcome v-else key="models" :selection="selection" :interaction="entry.interaction.value" :start-status="busy ? 'starting' : 'idle'" :start-error="error" @select="entry.selectModel({ selection: $event })" @start="start" @open-discovery="entry.openDiscovery" @local-input="localInput" @dragover="dragOver({ event: $event })" @dragleave="dragLeave({ event: $event })" @drop="drop({ event: $event })" @dragend="dragVisibility = 'hidden'" />
    </Transition>
    <template #overlay>
      <div v-if="dragVisibility === 'visible'" data-testid="model-drop-overlay" tw-class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10"><div tw-class="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-xl dark:bg-gray-800"><FolderInputIcon aria-hidden="true" tw-class="h-6 w-6 text-blue-500" /><span tw-class="text-lg font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.AppEntrySurface__drop_gguf_files_or_model_folders() }}</span></div></div>
    </template>
  </BrowserModelDialog>
  <LocalModelSelectionDialog v-if="localInputOpened" />
</template>
