<script setup lang="ts">
import { computed, defineAsyncComponent, markRaw, nextTick, onScopeDispose, ref, shallowRef, watch, type Component } from 'vue';
import { CirclePlayIcon, FolderInputIcon, FolderOpenIcon, Loader2Icon } from 'lucide-vue-next';
import BrowserModelDialog from './BrowserModelDialog.vue';
import BrowserModelWelcome from './BrowserModelWelcome.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import LlamaCppBrowserLocalFileRecovery from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFileRecovery.vue';
import { browserModelRepositoryPresentation, browserModelSuggestionSelection, type BrowserModelLocalInput, type BrowserModelSelection, type ModelDiscoveryTab } from './browser-model-presentation';
import { useCspMessageHintsOnly } from '@/composables/useCspMessageHintsOnly';
import type { CspHintTarget } from '@/logic/csp-message-hints/types';
import { useAppEntry } from '@/composables/useAppEntry';
import { useToast } from '@/composables/useToast';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { confirmModelLaunchSelection, modelLaunchEntryState, retireModelLaunch, retryModelLaunch, startModelLaunch, type ModelLaunchEntryState } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { captureDroppedLocalModels } from '@/features/llama-cpp-browser/logic/local-model-input';
import { waitForPresentationPaint } from '@/logic/startup/presentation-frame';
import { createModuleLoader } from '@/utils/module-loader';
import { scheduleIdleTask, type ScheduledIdleTask } from '@/utils/idle-task';
import { ensureStrings, lazyStrings } from '@/strings';
import type { BrowserProvidedLmEndpoint, HttpEndpoint } from '@/01-models/types';

// OnBoardingModalV2 and its cards are synchronous. Only action-owned views
// are deferred, with optional UI prefetch after the initial paint opportunity.
const fileSelectionLoader = createModuleLoader({ importModule: () => import('./BrowserModelFileSelection.vue'), onPrefetchError: () => {} });
const FileSelection = shallowRef<Component>();
const connectionLoader = createModuleLoader({ importModule: () => import('./BrowserConnectionSelection.vue'), onPrefetchError: () => {} });
const ConnectionSelection = shallowRef<Component>();
const localModelInputLoader = createModuleLoader({ importModule: () => import('./OnBoardingModalV2LocalModelInput.vue'), onPrefetchError: () => {} });
const OnBoardingModalV2LocalModelInput = defineAsyncComponent({ loader: localModelInputLoader.load });
type ConnectionPresentation = {
  initialEndpoint: 'openai' | 'browser_provided_lm',
  isCurrent(): boolean,
  applySelection: ({ endpoint, modelId }: { endpoint: HttpEndpoint | BrowserProvidedLmEndpoint, modelId: string }) => Promise<void>,
};
const connection = shallowRef<ConnectionPresentation>();
const connectionActive = computed(() => connection.value?.isCurrent() === true && entry.interaction.value === 'ready');
const openingConnection = ref<symbol>();
const savingConnection = ref<symbol>();
const connectionLoadFailed = ref(false);
const browserAvailability = ref<'unchecked' | 'available' | 'downloadable' | 'downloading' | 'unavailable'>('unchecked');
const browserSelection = ref<'selected' | 'unselected'>('unselected');
const browserProvidedModel = computed(() => {
  const availability = browserAvailability.value;
  switch (availability) {
  case 'available': case 'downloadable': case 'downloading': return { availability, selection: browserSelection.value };
  case 'unchecked': case 'unavailable': return undefined;
  default: {
    const exhaustive: never = availability;
    return exhaustive;
  }
  }
});
// LocalModelSelectionDialog imports the local-input workflow, so load it only on a file action.
const localSelectionLoader = createModuleLoader({ importModule: () => import('./LocalModelSelectionDialog.vue'), onPrefetchError: () => {} });
const LocalModelSelectionDialog = shallowRef<Component>();
const entry = useAppEntry();
const dialog = ref<InstanceType<typeof BrowserModelDialog>>();
const { addToast } = useToast();
const operation = ref<symbol>();
const files = shallowRef<Extract<ModelLaunchEntryState, { status: 'needs-selection' }>>();
const dragVisibility = ref<'hidden' | 'visible'>('hidden');
// This presentation choice is local to V2, not the chat pane's persisted
// source-tab preference. Either view always remains manually available.
const welcomeSource = ref<'showcase' | 'local-files'>('showcase');
const welcomeSourceSelection = ref<'automatic' | 'manual'>('automatic');
const localPanelBusy = ref(false);
const localModelInputPrepared = ref(false);
const localModelInputMounted = ref(false);
const localModelInputLoading = ref(false);
const localModelInputLoadFailed = ref(false);
const localModelViewKey = ref(0);
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
const busy = computed(() => openingConnection.value !== undefined || state.value?.status === 'checking' || (operation.value !== undefined && loadingFiles.value === operation.value));
const error = computed(() => connectionLoadFailed.value ? lazyStrings.OnBoardingModalV2__could_not_open_connection_settings() : state.value?.status === 'failed' || loadError.value ? lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model() : undefined);
const fileModel = computed(() => browserModelRepositoryPresentation({ repository: files.value?.input ?? '', bytes: undefined }));
const open = computed(() => entry.modelSelection.value?.phase === 'open');
const localSourceVisible = computed(() => open.value && welcomeSource.value === 'local-files' && files.value === undefined && connection.value === undefined && entry.discovery.value === undefined);
const localSourceActive = computed(() => localSourceVisible.value && entry.interaction.value === 'ready' && entry.discovery.value === undefined);
const dismissible = computed(() => savingConnection.value === undefined && !(state.value?.status === 'checking' && state.value.phase === 'opening-chat'));
// The local view's file and linked-folder controls own their respective drops.
// A directory dropped for linking must not also start the welcome-file path.
const canDrop = computed(() => open.value && entry.interaction.value === 'ready' && !busy.value && welcomeSource.value === 'showcase' && files.value === undefined && connection.value === undefined);
const huggingFaceAccessHint = useCspMessageHintsOnly({ target: computed<CspHintTarget | undefined>(() => open.value && welcomeSourceSelection.value === 'automatic' ? { kind: 'onboarding-v2-huggingface-access' } : undefined) });

function recordWelcomeInteraction(): void {
  welcomeSourceSelection.value = 'manual';
}

async function prepareLocalModelInput(): Promise<void> {
  if (disposed || localModelInputPrepared.value || localModelInputLoading.value) {
    return;
  }
  localModelInputLoading.value = true;
  localModelInputLoadFailed.value = false;
  try {
    await localModelInputLoader.load();
    if (!disposed) {
      localModelInputPrepared.value = true;
    }
  } catch {
    if (!disposed) {
      localModelInputLoadFailed.value = true;
    }
  } finally {
    if (!disposed) {
      localModelInputLoading.value = false;
    }
  }
}

function selectWelcomeModel({ selection }: { selection: BrowserModelSelection }): void {
  recordWelcomeInteraction();
  entry.selectModel({ selection });
}

function selectWelcomeBrowserModel({ selection }: { selection: 'selected' | 'unselected' }): void {
  recordWelcomeInteraction();
  browserSelection.value = selection;
}

async function openModelDiscovery({ tab }: { tab: ModelDiscoveryTab | undefined }): Promise<void> {
  if (!open.value || entry.interaction.value !== 'ready' || busy.value || localPanelBusy.value) {
    return;
  }
  recordWelcomeInteraction();
  await entry.openDiscovery({ tab });
}

function selectWelcomeSource({ source }: { source: 'showcase' | 'local-files' }): void {
  if (!open.value || entry.interaction.value !== 'ready' || busy.value || localPanelBusy.value) {
    return;
  }
  recordWelcomeInteraction();
  if (source === welcomeSource.value) {
    return;
  }
  welcomeSource.value = source;
  dragVisibility.value = 'hidden';
  // A failed card attempt is no longer the active operation after switching
  // to local input. Keep the browsed model selection for the return journey.
  retire();
  loadError.value = false;
  connectionLoadFailed.value = false;
}

watch(state, (current, previous) => {
  if (current?.status !== 'failed' || current.problem !== 'failed' || previous?.status === 'failed') {
    return;
  }
  // Reveal a real failed attempt once. Optional CSP updates and changes to
  // locale or the currently browsed card must never take over manual scrolling.
  void dialog.value?.revealPreparationError({ isCurrent: () => state.value === current && open.value && entry.interaction.value === 'ready' && files.value === undefined && connection.value === undefined && !connectionLoadFailed.value && !loadError.value });
});

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
    connection.value = undefined;
    connectionLoadFailed.value = false;
    openingConnection.value = undefined;
    savingConnection.value = undefined;
    browserAvailability.value = 'unchecked';
    browserSelection.value = 'unselected';
    welcomeSource.value = 'showcase';
    welcomeSourceSelection.value = 'automatic';
    localPanelBusy.value = false;
    localModelInputMounted.value = false;
    localModelViewKey.value++;
  }
});

// Explicit exception requested by the project owner: OnBoardingModalV2
// may use CSP diagnostics to choose its initial welcome view.
// Keep both views and their actions available; respect manual selection.
// Elsewhere, CSP diagnostics are for explanatory hints only and must not
// control feature behavior or enable/disable actions.
watch([huggingFaceAccessHint, () => entry.modelSelection.value?.target], ([hint]) => {
  if (hint !== undefined && welcomeSourceSelection.value === 'automatic' && open.value && !busy.value && !localPanelBusy.value && files.value === undefined && connection.value === undefined && entry.discovery.value === undefined) {
    welcomeSource.value = 'local-files';
    dragVisibility.value = 'hidden';
  }
  // Missing or failed diagnostics preserve the normal default. Once shown,
  // local input is not removed because later evidence becomes unavailable.
}, { immediate: true });

watch(localSourceVisible, visible => {
  if (visible) {
    void prepareLocalModelInput();
  }
}, { immediate: true });

watch([entry.interaction, open, () => entry.modelSelection.value?.target], async ([interaction, visible, target], _previous, onCleanup) => {
  prefetch?.cancel();
  let current = true;
  onCleanup(() => {
    current = false;
    prefetch?.cancel();
  });
  switch (interaction) {
  case 'blocked': prefetch?.cancel();
    return;
  case 'ready': break;
  default: {
    const exhaustive: never = interaction;
    throw new Error(String(exhaustive));
  }
  }
  if (!visible || target === undefined) {
    return;
  }
  await nextTick();
  await waitForPresentationPaint({ window });
  if (current && !disposed && open.value && entry.interaction.value === 'ready') {
    void detectBrowserModel({ isCurrent: () => current && !disposed && open.value && entry.modelSelection.value?.target === target });
    prefetch = scheduleIdleTask({
      task: async () => {
        await Promise.all([fileSelectionLoader.prefetch(), connectionLoader.prefetch(), localModelInputLoader.prefetch()]);
      },
      timeoutMs: 1500,
      fallbackDelayMs: 200,
    });
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

async function detectBrowserModel({ isCurrent }: { isCurrent(): boolean }): Promise<void> {
  // Check capability after the initial paint, without mounting status UI or
  // importing runtime code. Availability must never authorize create().
  if (!('LanguageModel' in globalThis)) {
    if (isCurrent()) {
      browserAvailability.value = 'unavailable';
    }
    return;
  }
  try {
    const api = await import('@/features/prompt-api/api');
    if (!isCurrent()) {
      return;
    }
    const availability = api.getPromptApiLanguageModel() === undefined ? 'unavailable' : await api.getPromptApiAvailability({ inputMode: 'text' });
    if (isCurrent()) {
      browserAvailability.value = availability;
    }
  } catch {
    if (isCurrent()) {
      browserAvailability.value = 'unavailable';
    }
  }
}

async function openConnections({ endpoint }: { endpoint: 'openai' | 'browser_provided_lm' }): Promise<void> {
  const selection = entry.modelSelection.value;
  if (selection?.phase !== 'open' || entry.interaction.value !== 'ready' || busy.value || localPanelBusy.value) {
    return;
  }
  recordWelcomeInteraction();
  const context = entry.captureModelLaunchContext();
  const target = selection.target;
  const current = () => !disposed && context.isCurrent() && entry.modelSelection.value?.phase === 'open' && entry.modelSelection.value.target === target;
  const opening = Symbol('connection-form-import');
  openingConnection.value = opening;
  connectionLoadFailed.value = false;
  retire();
  try {
    const module = await connectionLoader.load();
    if (!current()) {
      return;
    }
    ConnectionSelection.value = markRaw(module.default);
    const presentation: ConnectionPresentation = {
      initialEndpoint: endpoint,
      isCurrent: () => current() && connection.value === presentation,
      applySelection: async ({ endpoint: selectedEndpoint, modelId }) => {
        if (!presentation.isCurrent() || savingConnection.value !== undefined || entry.interaction.value !== 'ready') {
          throw new Error('Model selection is no longer active');
        }
        const saving = Symbol('connection-commit');
        savingConnection.value = saving;
        try {
          const { applyModelConnectionSelection } = await import('@/logic/apply-model-connection');
          await applyModelConnectionSelection({ target, endpoint: selectedEndpoint, modelId, isCurrent: presentation.isCurrent });
          if (!presentation.isCurrent()) {
            throw new Error('Model selection is no longer active');
          }
          entry.closeModelSelection();
        } finally {
          if (savingConnection.value === saving) {
            savingConnection.value = undefined;
          }
        }
      },
    };
    connection.value = presentation;
  } catch {
    if (current()) {
      connectionLoadFailed.value = true;
    }
  } finally {
    if (openingConnection.value === opening) {
      openingConnection.value = undefined;
    }
  }
}

function backFromConnections(): void {
  if (savingConnection.value === undefined) {
    connection.value = undefined;
  }
}

function start(): void {
  if (!open.value || entry.interaction.value !== 'ready' || busy.value || localPanelBusy.value) {
    return;
  }
  recordWelcomeInteraction();
  const selected = browserModelSuggestionSelection({ selection: selection.value });
  if (selected !== undefined) {
    loadError.value = false;
    connectionLoadFailed.value = false;
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
  recordWelcomeInteraction();
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
      console.error('[OnBoardingModalV2] Could not open local model:', error);
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
    recordWelcomeInteraction();
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
  <BrowserModelDialog ref="dialog" :open="open" :dismissible="dismissible" :suspended="entry.discovery.value !== undefined" @close="close" @closed="entry.finishModelSelectionClose">
    <Transition name="browser-model-step" mode="out-in" @enter="dialog?.focusPanel()">
      <FileSelection v-if="files" key="files" :model="fileModel" :selection="files" :busy="entry.interaction.value !== 'ready' || busy" :error="error" :action="state?.status === 'failed' ? 'retry' : 'confirm'" @back="back" @confirm="confirm" @retry="retryModelLaunch" />
      <ConnectionSelection v-else-if="connection && ConnectionSelection" key="connections" :initial-endpoint="connection.initialEndpoint" :active="connectionActive" :apply-selection="connection.applySelection" @back="backFromConnections" />
      <BrowserModelWelcome v-else key="models" :model-source="welcomeSource" :selection="selection" :browser-provided-model="browserProvidedModel" :interaction="entry.interaction.value" :start-status="busy || localPanelBusy ? 'starting' : 'idle'" :start-error="error" @select="selectWelcomeModel({ selection: $event })" @select-browser-model="selectWelcomeBrowserModel({ selection: $event })" @open-connections="openConnections({ endpoint: $event })" @start="start" @open-discovery="openModelDiscovery" @browse-models="recordWelcomeInteraction" @local-input="localInput" @dragover="dragOver({ event: $event })" @dragleave="dragLeave({ event: $event })" @drop="drop({ event: $event })" @dragend="dragVisibility = 'hidden'">
        <template #display-controls>
          <!-- Label only the other destination and keep the total
               width fixed so switching does not move the adjacent controls. -->
          <div role="group" :aria-label="lazyStrings.OnBoardingModalV2__model_source()" data-testid="onboarding-model-source" tw-class="relative flex w-[8.75rem] shrink-0 rounded-xl border border-gray-300 bg-gray-200 p-0.5 shadow-[inset_0_2px_4px_rgba(0,0,0,0.15)] dark:border-gray-800 dark:bg-black">
            <span aria-hidden="true" :tw-class="['pointer-events-none absolute inset-y-0.5 w-8 rounded-lg border border-gray-200 bg-white shadow-[0_2px_0_rgba(0,0,0,0.05),0_4px_6px_rgba(0,0,0,0.15)] transition-[left] duration-200 ease-out dark:border-gray-600 dark:bg-gray-700 dark:shadow-[0_4px_10px_rgba(0,0,0,0.5)] motion-reduce:transition-none', welcomeSource === 'local-files' ? 'left-[calc(100%-2.125rem)]' : 'left-0.5']" />
            <button type="button" data-testid="onboarding-showcase-toggle" :aria-pressed="welcomeSource === 'showcase'" :aria-label="lazyStrings.OnBoardingModalV2__try_a_model()" :title="lazyStrings.OnBoardingModalV2__download_and_run_in_naidan()" :disabled="entry.interaction.value !== 'ready' || busy || localPanelBusy" :tw-class="['relative z-10 inline-flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-xs font-medium leading-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50', welcomeSource === 'showcase' ? 'w-8 shrink-0 text-blue-600 dark:text-blue-300' : 'flex-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100']" @click="selectWelcomeSource({ source: 'showcase' })"><CirclePlayIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /><span v-if="welcomeSource !== 'showcase'" tw-class="min-w-0 truncate">{{ lazyStrings.OnBoardingModalV2__try_a_model() }}</span></button>
            <button type="button" data-testid="onboarding-local-model-toggle" :aria-pressed="welcomeSource === 'local-files'" :aria-label="lazyStrings.OnBoardingModalV2__model_files()" :title="lazyStrings.OnBoardingModalV2__use_downloaded_model_files()" :disabled="entry.interaction.value !== 'ready' || busy || localPanelBusy" :tw-class="['relative z-10 inline-flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-xs font-medium leading-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 motion-reduce:transition-none disabled:opacity-50', welcomeSource === 'local-files' ? 'w-8 shrink-0 text-blue-600 dark:text-blue-300' : 'flex-1 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100']" @click="selectWelcomeSource({ source: 'local-files' })"><FolderOpenIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /><span v-if="welcomeSource !== 'local-files'" tw-class="min-w-0 truncate">{{ lazyStrings.OnBoardingModalV2__model_files() }}</span></button>
          </div>
        </template>
        <template #local-model-source>
          <!-- Prefetch code without mounting UI. After its first visible mount,
               the welcome frame retains this source with v-show and inert. -->
          <OnBoardingModalV2LocalModelInput v-if="localModelInputPrepared && (localSourceVisible || localModelInputMounted)" :key="localModelViewKey" :active="localSourceActive" :disabled="entry.interaction.value !== 'ready' || busy" :accept-local-input="localInput" @busy="localPanelBusy = $event" @vue:mounted="localModelInputMounted = true" @vue:unmounted="localModelInputMounted = false" />
          <div v-else-if="localModelInputLoadFailed" role="alert" tw-class="mx-auto w-full max-w-xl space-y-2 rounded-xl border border-gray-200 p-4 text-left text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300"><p>{{ lazyStrings.OnBoardingModalV2__could_not_open_model_files_view() }}</p><button type="button" :disabled="entry.interaction.value !== 'ready' || localModelInputLoading" tw-class="min-h-9 rounded-lg px-3 py-2 font-medium text-blue-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-blue-400 dark:hover:bg-gray-800 disabled:opacity-50" @click="prepareLocalModelInput">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button></div>
          <p v-else role="status" tw-class="mx-auto flex min-h-44 w-full max-w-xl items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.llamaCppBrowser__loading() }}</p>
        </template>
        <template #model-preflight-hint>
          <!-- Preflight guidance is intentional: people can switch to local
               files, while every model action stays available to try. -->
          <CspMessageHint v-if="!connectionLoadFailed && state?.status !== 'failed' && !loadError && browserSelection !== 'selected'" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" tw-class="mx-auto w-full max-w-md" />
        </template>
        <template #start-error-hint>
          <!-- Only a failed model attempt owned by OnBoardingModalV2 gets recovery guidance, not local or connection UI failures. -->
          <HuggingFaceDownloadFailureHint v-if="state?.status === 'failed' && state.problem === 'failed' && !connectionLoadFailed && !loadError"><LlamaCppBrowserLocalFileRecovery :disabled="entry.interaction.value !== 'ready' || busy" :accept-local-input="localInput" /></HuggingFaceDownloadFailureHint>
        </template>
      </BrowserModelWelcome>
    </Transition>
    <template #overlay>
      <div v-if="dragVisibility === 'visible'" data-testid="model-drop-overlay" tw-class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-blue-500 bg-blue-500/10"><div tw-class="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-xl dark:bg-gray-800"><FolderInputIcon aria-hidden="true" tw-class="h-6 w-6 text-blue-500" /><span tw-class="text-lg font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.AppEntrySurface__drop_gguf_files_or_model_folders() }}</span></div></div>
    </template>
  </BrowserModelDialog>
  <LocalModelSelectionDialog v-if="localInputOpened" />
</template>
