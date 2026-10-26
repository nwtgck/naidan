<script setup lang="ts">
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';
import LlamaCppBrowserLocalFileRecovery from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFileRecovery.vue';
import { computed, nextTick, onUnmounted, ref, shallowRef, watch, type Component } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, ChevronRightIcon, CheckIcon, CpuIcon, HardDriveIcon, Loader2Icon, SearchIcon, ShieldCheckIcon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useModelDiscoveryTab } from '@/composables/useModelDiscoveryTab';
import { promiseAllKeyed } from '@/utils/promise';
import { scheduleIdleTask, type ScheduledIdleTask } from '@/utils/idle-task';
import { errorCode, type ErrorCode, type LocalModel } from '@/features/llama-cpp-browser/types';
import type { ModelInventorySource } from '@/features/llama-cpp-browser/composables/model-inventory';
import type { HostModelInventoryIssue } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { matchesSuggestedBrowserModel } from './browser-model-presentation';
import { modelSuggestions, preferredQuantizationHint, suggestedQuantizationLabel } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { confirmModelLaunchSelection, modelLaunchEntryState, retireModelLaunch, retryModelLaunch, startModelLaunch } from '@/features/llama-cpp-browser/model-launch/entry-state';
import type { ModelDiscoveryTab } from './browser-model-presentation';
import BrowserModelPreparation from './BrowserModelPreparation.vue';
import SettingsSelect from './SettingsSelect.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';

type ModelPreview = { suggestionId: string | undefined, repository: string, variant: string, name: string, developer: string };
const props = defineProps<{ visibility: 'open' | 'closed', tab: ModelDiscoveryTab | undefined, interaction?: 'blocked' | 'ready', currentModelId?: string, selectionTarget?: 'chat' }>();
const emit = defineEmits<{ close: [] }>();
const inventory = shallowRef<LocalModel[]>([]);
const inventoryIssues = shallowRef<readonly HostModelInventoryIssue[]>([]);
const inventoryError = ref<ErrorCode>();
const inventoryRefreshing = ref(false);
const inventorySource = computed<ModelInventorySource>(() => ({ models: inventory.value, hostIssues: inventoryIssues.value, error: inventoryError.value, refreshing: inventoryRefreshing.value, refresh: refreshInventory }));
let inventoryController: AbortController | undefined;
let inventoryPromise: Promise<void> | undefined;
let inventoryRequested = false;
let disposed = false;
let unsubscribeInventory: (() => void) | undefined;
const savedModels = computed(() => inventory.value.filter(model => model.modelId.startsWith('hf.co/')));
const currentModel = computed(() => {
  const modelId = props.currentModelId;
  if (modelId === undefined) {
    return undefined;
  }
  return inventory.value.find(model => model.modelId === modelId) ?? { modelId, source: undefined };
});
const open = computed(() => props.visibility === 'open');
const panel = ref<HTMLElement>();
const listViewport = ref<HTMLElement>();
const previewHeading = ref<HTMLElement>();
const preference = useModelDiscoveryTab();
const activeTab = ref<ModelDiscoveryTab>(props.tab ?? preference.remembered.value);
const query = ref('');
const repositoryInput = ref('');
const repositoryError = ref(false);
const preview = shallowRef<ModelPreview>();
const operation = ref<symbol>();
const HuggingFaceSearch = shallowRef<Component>();
const LocalModels = shallowRef<Component>();
const loadError = ref(false);
const loading = new Map<ModelDiscoveryTab, { session: object, promise: Promise<void> }>();
let preparationSession: object | undefined;
let scheduledPreparation: ScheduledIdleTask | undefined;
const scrollPositions = new Map<ModelDiscoveryTab, number>();
let previousFocus: HTMLElement | undefined;
let selectedRow: HTMLElement | undefined;
let previousBodyOverflow = '';
let background: HTMLElement | undefined;
let previousInert = false;
let backgroundLocked = false;

const catalogCandidates = computed(() => modelSuggestions.map(suggestion => {
  const hint = preferredQuantizationHint({ suggestion });
  return { id: suggestion.id, name: suggestion.name, developer: suggestion.developer, bytes: hint.approximateModelBytes, memoryGiB: hint.suggestedMemoryGiB, saved: suggestion.quantizationHints.some(option => savedModels.value.some(model => matchesSuggestedBrowserModel({ model, hint: option }))), current: currentModel.value !== undefined && suggestion.quantizationHints.some(option => matchesSuggestedBrowserModel({ model: currentModel.value!, hint: option })) };
}));
const filteredCandidates = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return catalogCandidates.value.filter(candidate => `${candidate.name} ${candidate.developer}`.toLocaleLowerCase().includes(search));
});
const previewSuggestion = computed(() => modelSuggestions.find(candidate => candidate.id === preview.value?.suggestionId));
const previewHint = computed(() => {
  const current = preview.value;
  return current === undefined ? undefined : previewSuggestion.value?.quantizationHints.find(hint => hint.hfRepository === current.repository && hint.preferredQuantization === current.variant);
});
const previewModel = computed(() => preview.value === undefined ? undefined : { name: preview.value.name, developer: preview.value.developer, repository: preview.value.repository, bytes: previewHint.value?.approximateModelBytes, memoryGiB: previewHint.value?.suggestedMemoryGiB });
const previewRepository = computed(() => preview.value?.repository ?? '');
const previewSaved = computed(() => previewHint.value !== undefined && savedModels.value.some(model => matchesSuggestedBrowserModel({ model, hint: previewHint.value! })));
const previewCurrent = computed(() => previewHint.value !== undefined && currentModel.value !== undefined && matchesSuggestedBrowserModel({ model: currentModel.value, hint: previewHint.value }));
const quantizationOptions = computed(() => previewSuggestion.value?.quantizationHints.map(hint => {
  const label = suggestedQuantizationLabel({ quantization: hint });
  const savedLabel = lazyStrings.ModelDiscoveryPanel__saved();
  const saved = savedModels.value.some(model => matchesSuggestedBrowserModel({ model, hint }));
  return { value: hint.id, label: saved && savedLabel !== undefined ? `${label} · ${savedLabel}` : label, detail: sizeLabel({ bytes: hint.approximateModelBytes }) };
}) ?? []);
const launchState = computed(() => {
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'idle': return undefined;
  case 'checking': case 'needs-selection': case 'failed': return state.operation === operation.value ? state : undefined;
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});
const selectionState = computed(() => {
  const state = launchState.value;
  if (state === undefined) {
    return undefined;
  }
  switch (state.status) {
  case 'checking': case 'failed': return undefined;
  case 'needs-selection': return state;
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});
const isStarting = computed(() => {
  const state = launchState.value;
  if (state === undefined) {
    return false;
  }
  switch (state.status) {
  case 'checking': return true;
  case 'needs-selection': case 'failed': return false;
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});
const starting = computed(() => isStarting.value ? 'starting' : 'idle');
const globalStarting = computed(() => {
  const state = modelLaunchEntryState.value;
  switch (state.status) {
  case 'checking': return 'creating';
  case 'idle': case 'needs-selection': case 'failed': return 'idle';
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});
const startError = computed(() => {
  const state = launchState.value;
  if (state === undefined) {
    return undefined;
  }
  switch (state.status) {
  case 'checking': case 'needs-selection': return undefined;
  case 'failed':
    switch (state.problem) {
    case 'variant-unavailable': return lazyStrings.LlamaCppBrowserModelLaunch__variant_not_found();
    case 'companion-required': return lazyStrings.LlamaCppBrowserModelLaunch__companion_needs_selection();
    case 'invalid-input': case 'failed': return lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model();
    default: {
      const exhaustive: never = state.problem;
      return exhaustive;
    }
    }
  default: {
    const exhaustive: never = state;
    return exhaustive;
  }
  }
});

function refreshInventory(): Promise<void> {
  if (!open.value || disposed) {
    return Promise.resolve();
  }
  inventoryRequested = true;
  if (inventoryPromise !== undefined) {
    return inventoryPromise;
  }
  const controller = new AbortController();
  inventoryController = controller;
  inventoryRefreshing.value = true;
  inventoryPromise = Promise.resolve().then(async () => {
    try {
      // Opening discovery may scan local files; its initial chunk must not pull
      // in the filesystem runtime or the current-chat/settings service graph.
      const { inventoryTools, modelFiles, hostStore } = await promiseAllKeyed({
        inventoryTools: import('@/features/llama-cpp-browser/composables/model-inventory'),
        modelFiles: import('@/features/llama-cpp-browser/model-files'),
        hostStore: import('@/features/llama-cpp-browser/runtime/host-model-store'),
      });
      if (controller.signal.aborted || !open.value) {
        return;
      }
      unsubscribeInventory ??= modelFiles.llamaCppBrowserModelFiles.subscribeModelList({
        listener: () => {
          if (open.value) {
            void refreshInventory();
          }
        },
      });
      while (inventoryRequested && !controller.signal.aborted && open.value && !disposed) {
        inventoryRequested = false;
        inventoryError.value = undefined;
        const isStorageCurrent = modelFiles.captureModelFileStorage();
        try {
          const models = await inventoryTools.listModelInventory({ signal: controller.signal });
          if (!controller.signal.aborted && open.value && !isStorageCurrent()) {
            inventoryRequested = true;
          } else if (!controller.signal.aborted && open.value && !inventoryRequested) {
            inventory.value = models;
            inventoryIssues.value = [...hostStore.getHostModelInventoryIssues()];
          }
        } catch (error) {
          if (!controller.signal.aborted && open.value && !inventoryRequested) {
            inventory.value = [];
            inventoryIssues.value = [];
            inventoryError.value = errorCode({ error });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && open.value) {
        inventoryRequested = false;
        inventory.value = [];
        inventoryIssues.value = [];
        inventoryError.value = errorCode({ error });
      }
    }
  }).finally(() => {
    if (inventoryController === controller) {
      inventoryRefreshing.value = false;
    }
    inventoryPromise = undefined;
    // A close/open cycle can queue a fresh scan while an aborted API settles.
    // Callers awaiting revalidation must also await that replacement scan.
    return inventoryRequested && open.value && !disposed ? refreshInventory() : undefined;
  });
  return inventoryPromise;
}

function refreshInventoryOnFocus(): void {
  if (open.value) {
    void refreshInventory();
  }
}

watch(open, visible => {
  inventoryController?.abort();
  inventoryRequested = false;
  inventory.value = [];
  inventoryIssues.value = [];
  inventoryError.value = undefined;
  inventoryRefreshing.value = false;
  if (visible) {
    window.addEventListener('focus', refreshInventoryOnFocus);
    void refreshInventory();
  } else {
    window.removeEventListener('focus', refreshInventoryOnFocus);
    unsubscribeInventory?.();
    unsubscribeInventory = undefined;
  }
}, { immediate: true });
onUnmounted(() => {
  disposed = true;
  inventoryRequested = false;
  window.removeEventListener('focus', refreshInventoryOnFocus);
  inventoryController?.abort();
  unsubscribeInventory?.();
});

function sizeLabel({ bytes }: { bytes: number | undefined }): string | undefined {
  return bytes === undefined ? lazyStrings.llamaCppBrowser__size_not_checked() : lazyStrings.llamaCppBrowser__approximately_gb({ size: (bytes / 1e9).toFixed(1) });
}

function retireOperation(): void {
  if (operation.value !== undefined) {
    retireModelLaunch({ operation: operation.value });
  }
  operation.value = undefined;
}

function close(): void {
  retireOperation();
  emit('close');
}

function rememberListScroll({ event }: { event: Event }): void {
  if (!preview.value && event.target instanceof HTMLElement) {
    scrollPositions.set(activeTab.value, event.target.scrollTop);
  }
}

function showPreview({ value }: { value: ModelPreview }): void {
  if (!open.value || props.interaction === 'blocked') {
    return;
  }
  retireOperation();
  if (listViewport.value) {
    scrollPositions.set(activeTab.value, listViewport.value.scrollTop);
  }
  selectedRow = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  preview.value = value;
  void nextTick(() => previewHeading.value?.focus({ preventScroll: true }));
}

function chooseCandidate({ id }: { id: string }): void {
  const suggestion = modelSuggestions.find(candidate => candidate.id === id);
  if (!suggestion) {
    return;
  }
  const hint = suggestion.quantizationHints.find(option => savedModels.value.some(model => matchesSuggestedBrowserModel({ model, hint: option }))) ?? preferredQuantizationHint({ suggestion });
  showPreview({ value: { suggestionId: id, repository: hint.hfRepository, variant: hint.preferredQuantization, name: suggestion.name, developer: suggestion.developer } });
}

function chooseRepository({ input }: { input: string }): void {
  try {
    const { repository, requestedVariant } = parseRepository({ input });
    const suggestion = modelSuggestions.find(candidate => candidate.quantizationHints.some(hint => hint.hfRepository.toLowerCase() === repository.toLowerCase()));
    const hint = suggestion?.quantizationHints.find(candidate => candidate.hfRepository.toLowerCase() === repository.toLowerCase() && (requestedVariant === undefined || candidate.preferredQuantization === requestedVariant));
    repositoryError.value = false;
    showPreview({ value: { suggestionId: suggestion?.id, repository, variant: requestedVariant ?? hint?.preferredQuantization ?? '', name: suggestion?.name ?? repository.split('/').slice(1).join('/').replace(/-GGUF$/i, ''), developer: suggestion?.developer ?? repository.split('/')[0]! } });
  } catch {
    repositoryError.value = true;
  }
}

function selectQuantization({ value }: { value: string }): void {
  if (!preview.value || isStarting.value) {
    return;
  }
  const hint = previewSuggestion.value?.quantizationHints.find(candidate => candidate.id === value);
  if (!hint) {
    return;
  }
  retireOperation();
  preview.value = { ...preview.value, repository: hint.hfRepository, variant: hint.preferredQuantization };
}

function editVariant({ event }: { event: Event }): void {
  if (preview.value && event.target instanceof HTMLInputElement && !isStarting.value) {
    retireOperation();
    preview.value = { ...preview.value, variant: event.target.value };
  }
}

async function backToList(): Promise<void> {
  if (isStarting.value) {
    return;
  }
  retireOperation();
  preview.value = undefined;
  await nextTick();
  if (listViewport.value) {
    listViewport.value.scrollTop = scrollPositions.get(activeTab.value) ?? 0;
  }
  selectedRow?.focus({ preventScroll: true });
}

function startPreview(): void {
  if (!open.value || props.interaction === 'blocked' || !preview.value || isStarting.value) {
    return;
  }
  const state = launchState.value;
  if (state !== undefined) {
    switch (state.status) {
    case 'checking': case 'needs-selection': return;
    case 'failed': retryModelLaunch();
      return;
    default: {
      const exhaustive: never = state;
      throw new Error(String(exhaustive));
    }
    }
  }
  const tab = activeTab.value;
  let source: 'hugging-face' | 'catalog';
  switch (tab) {
  case 'hugging-face': source = 'hugging-face';
    break;
  case 'candidates': case 'local-files': source = 'catalog';
    break;
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
  operation.value = startModelLaunch({ request: { input: preview.value.repository, requestedVariant: preview.value.variant.trim() || undefined, multimodal: 'auto', destination: { kind: 'opfs' }, source } });
}

function submitRepositoryFromKeyboard({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  event.preventDefault();
  chooseRepository({ input: repositoryInput.value });
}

async function prepareTab({ tab, session }: { tab: ModelDiscoveryTab, session: object }): Promise<void> {
  if (!open.value || preparationSession !== session) {
    return;
  }
  if (tab === 'candidates' || (tab === 'hugging-face' && HuggingFaceSearch.value) || (tab === 'local-files' && LocalModels.value)) {
    return;
  }
  const prior = loading.get(tab);
  if (prior?.session === session) {
    return prior.promise;
  }
  const pending = (async () => {
    try {
      let component: Component;
      switch (tab) {
      case 'hugging-face': component = (await import('@/features/llama-cpp-browser/components/LlamaCppBrowserHuggingFaceSearch.vue')).default;
        break;
      case 'local-files': component = (await import('./BrowserModelLibrary.vue')).default;
        break;
      default: {
        const exhaustive: never = tab;
        throw new Error(String(exhaustive));
      }
      }
      // Imports themselves cannot be cancelled. A closed/replaced panel must
      // not mount a late component or run its setup effects.
      if (open.value && preparationSession === session) {
        switch (tab) {
        case 'hugging-face': HuggingFaceSearch.value = component;
          break;
        case 'local-files': LocalModels.value = component;
          break;
        default: {
          const exhaustive: never = tab;
          throw new Error(String(exhaustive));
        }
        }
      }
    } catch {
      if (open.value && preparationSession === session && activeTab.value === tab) {
        loadError.value = true;
      }
    } finally {
      if (loading.get(tab)?.session === session) {
        loading.delete(tab);
      }
    }
  })();
  loading.set(tab, { session, promise: pending });
  await pending;
}

async function loadActiveTab(): Promise<void> {
  loadError.value = false;
  if (preparationSession !== undefined) {
    await prepareTab({ tab: activeTab.value, session: preparationSession });
  }
}

function scheduleTabPreparation({ session, tabs }: { session: object, tabs: ModelDiscoveryTab[] }): void {
  scheduledPreparation = scheduleIdleTask({
    timeoutMs: 1500,
    fallbackDelayMs: 120,
    task: async () => {
      if (!open.value || preparationSession !== session) {
        return;
      }
      const [tab, ...remaining] = tabs;
      if (tab !== undefined) {
        // Render-only preparation loads each tab's strings and UI. Disabled
        // search never contacts Hugging Face; the library reuses our inventory.
        await prepareTab({ tab, session });
        await nextTick();
        if (open.value && preparationSession === session && remaining.length) {
          scheduleTabPreparation({ session, tabs: remaining });
        }
      }
    },
  });
}

function restoreBackground(): void {
  if (!backgroundLocked) {
    return;
  }
  backgroundLocked = false;
  if (background) {
    background.inert = previousInert;
  }
  background = undefined;
  document.body.style.overflow = previousBodyOverflow;
  const opener = previousFocus;
  previousFocus = undefined;
  void nextTick(() => {
    if (!open.value && opener?.isConnected && !opener.closest('[inert]')) {
      opener.focus({ preventScroll: true });
    }
  });
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing) {
    return;
  }
  const dialog = event.target instanceof Element ? event.target.closest('[role="dialog"]') : undefined;
  if (dialog && dialog !== panel.value) {
    return;
  }
  if (event.key === 'Escape') {
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  const elements = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? []).filter(element => !element.closest('[inert], [hidden], [aria-hidden="true"]'));
  const first = elements[0], last = elements.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value || document.activeElement === previewHeading.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function rememberTab({ tab }: { tab: ModelDiscoveryTab }): void {
  if (open.value && props.interaction !== 'blocked') {
    void preference.remember({ tab }).catch(() => {});
  }
}

function selectTab({ tab }: { tab: ModelDiscoveryTab }): void {
  if (!open.value || props.interaction === 'blocked') {
    return;
  }
  activeTab.value = tab;
  rememberTab({ tab });
}

function tabKeydown({ event }: { event: KeyboardEvent }): void {
  const tabs: ModelDiscoveryTab[] = ['candidates', 'hugging-face', 'local-files'];
  const index = tabs.indexOf(activeTab.value);
  let next: ModelDiscoveryTab | undefined;
  switch (event.key) {
  case 'ArrowLeft': next = tabs[(index + tabs.length - 1) % tabs.length];
    break;
  case 'ArrowRight': next = tabs[(index + 1) % tabs.length];
    break;
  case 'Home': next = tabs[0];
    break;
  case 'End': next = tabs.at(-1);
    break;
  default: return;
  }
  event.preventDefault();
  if (next) {
    selectTab({ tab: next });
  }
  void nextTick(() => panel.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
}

watch(repositoryInput, () => {
  repositoryError.value = false;
});
watch(activeTab, async () => {
  const tab = activeTab.value;
  const session = preparationSession;
  await loadActiveTab();
  await nextTick();
  if (open.value && preparationSession === session && activeTab.value === tab && listViewport.value) {
    listViewport.value.scrollTop = scrollPositions.get(tab) ?? 0;
  }
});
watch(() => props.tab, tab => {
  if (open.value) {
    activeTab.value = tab ?? preference.remembered.value;
    if (tab !== undefined && preparationSession !== undefined) {
      rememberTab({ tab });
    }
  }
});
watch(open, async visible => {
  scheduledPreparation?.cancel();
  preparationSession = undefined;
  if (!visible) {
    restoreBackground();
    return;
  }
  const session = {};
  preparationSession = session;
  activeTab.value = props.tab ?? preference.remembered.value;
  // A concrete entry (for example the Hugging Face hint) is a user selection.
  // Restoring the remembered tab itself must not write settings on every open.
  if (props.tab !== undefined) {
    rememberTab({ tab: props.tab });
  }
  preview.value = undefined;
  operation.value = undefined;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  previousBodyOverflow = document.body.style.overflow;
  background = document.getElementById('app') ?? undefined;
  previousInert = background?.inert ?? false;
  backgroundLocked = true;
  if (background) {
    background.inert = true;
  }
  document.body.style.overflow = 'hidden';
  void loadActiveTab();
  await nextTick();
  if (open.value && preparationSession === session) {
    panel.value?.focus({ preventScroll: true });
    scheduleTabPreparation({ session, tabs: ['hugging-face', 'local-files'] });
  }
}, { immediate: true });
onUnmounted(() => {
  preparationSession = undefined;
  scheduledPreparation?.cancel();
  restoreBackground();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <Teleport to="body">
    <Transition tw-enter-active-class="transition-opacity duration-300 motion-reduce:transition-none" tw-leave-active-class="transition-opacity duration-200 motion-reduce:transition-none" tw-enter-from-class="opacity-0" tw-leave-to-class="opacity-0">
      <div v-if="open" aria-hidden="true" data-testid="model-discovery-backdrop" tw-class="fixed inset-0 z-[200] bg-gray-950/20 dark:bg-black/40 backdrop-blur-[2px]" @click="close" />
    </Transition>
    <Transition tw-enter-active-class="transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" tw-leave-active-class="transition-[transform,opacity] duration-250 ease-in motion-reduce:transition-none" tw-enter-from-class="translate-x-full opacity-0" tw-leave-to-class="translate-x-full opacity-0">
      <aside v-show="open" :inert="!open || interaction === 'blocked' || undefined" :aria-hidden="!open" ref="panel" role="dialog" aria-modal="true" aria-labelledby="model-discovery-title" tabindex="-1" data-testid="model-discovery" tw-class="fixed inset-y-0 right-0 z-[210] flex w-full max-w-xl flex-col overflow-hidden border-l border-gray-200/80 bg-white shadow-2xl outline-none dark:border-gray-800 dark:bg-gray-900 sm:inset-y-3 sm:right-3 sm:rounded-2xl sm:border" @keydown="keydown({ event: $event })">
        <header tw-class="flex min-h-20 shrink-0 items-center justify-between gap-4 px-5 py-4 sm:px-8 sm:py-5">
          <div tw-class="min-w-0">
            <h2 id="model-discovery-title" :tw-class="preview ? 'sr-only' : 'text-lg font-semibold tracking-tight text-gray-900 dark:text-gray-100'">{{ lazyStrings.ModelDiscoveryPanel__find_models() }}</h2>
            <button v-if="preview" type="button" data-testid="discovery-back" :disabled="starting === 'starting'" tw-class="group -ml-2 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100" @click="backToList"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4 transition-transform group-hover:-translate-x-0.5 motion-reduce:transition-none" />{{ lazyStrings.ModelDiscoveryPanel__back_to_model_list() }}</button>
          </div>
          <button type="button" :aria-label="lazyStrings.ModelDiscoveryPanel__close()" data-testid="model-discovery-close" tw-class="-mr-2 grid h-10 w-10 shrink-0 place-items-center rounded-xl text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-100" @click="close"><XIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
        </header>

        <div tw-class="relative min-h-0 flex-1 overflow-hidden"><div v-if="loadError" role="alert" tw-class="absolute inset-x-5 top-3 z-20 rounded-xl border border-red-200 bg-white dark:bg-gray-900 p-3 text-xs text-red-600"><p>{{ lazyStrings.ModelDiscoveryPanel__could_not_load_models() }}</p><button type="button" tw-class="min-h-9 underline" @click="loadActiveTab">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button></div>
          <Transition name="discovery-list">
            <div v-show="!preview" :inert="preview !== undefined || undefined" :aria-hidden="preview !== undefined" tw-class="absolute inset-0 flex min-h-0 flex-col">
              <div role="tablist" @keydown="tabKeydown({ event: $event })" :aria-label="lazyStrings.ModelDiscoveryPanel__ways_to_find_models()" tw-class="flex shrink-0 gap-6 border-b border-gray-100 px-5 dark:border-gray-800 sm:px-8">
                <button id="candidate-tab" type="button" role="tab" :tabindex="activeTab === 'candidates' ? 0 : -1" :aria-selected="activeTab === 'candidates'" aria-controls="candidate-panel" :tw-class="['relative min-h-11 border-b-2 px-0.5 pb-3 pt-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', activeTab === 'candidates' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']" @click="selectTab({ tab: 'candidates' })">{{ lazyStrings.ModelDiscoveryPanel__candidate_models() }}<span tw-class="ml-1.5 text-[10px] font-normal tabular-nums text-gray-400">{{ catalogCandidates.length }}</span></button>
                <button id="hugging-face-tab" type="button" role="tab" :tabindex="activeTab === 'hugging-face' ? 0 : -1" :aria-selected="activeTab === 'hugging-face'" aria-controls="hugging-face-panel" :tw-class="['relative min-h-11 border-b-2 px-0.5 pb-3 pt-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', activeTab === 'hugging-face' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']" @click="selectTab({ tab: 'hugging-face' })">Hugging Face</button>
                <button id="local-files-tab" type="button" role="tab" :tabindex="activeTab === 'local-files' ? 0 : -1" :aria-selected="activeTab === 'local-files'" aria-controls="local-files-panel" :tw-class="['relative min-h-11 border-b-2 px-0.5 pb-3 pt-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', activeTab === 'local-files' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']" @click="selectTab({ tab: 'local-files' })">{{ lazyStrings.ModelDiscoveryPanel__models_on_your_device() }}</button>
              </div>
              <div ref="listViewport" data-testid="discovery-list-viewport" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-8" @scroll="rememberListScroll({ event: $event })">
                <div v-show="activeTab === 'candidates'" id="candidate-panel" :inert="activeTab !== 'candidates' || undefined" role="tabpanel" aria-labelledby="candidate-tab" tw-class="space-y-4">
                  <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__runs_llama_cpp_in_the_browser_and_supports_many_gguf_models() }}</p>
                  <div tw-class="relative">
                    <SearchIcon aria-hidden="true" tw-class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input v-model="query" type="search" :aria-label="lazyStrings.ModelDiscoveryPanel__filter_candidate_models()" :placeholder="lazyStrings.ModelDiscoveryPanel__filter_by_model_or_developer()" data-testid="candidate-search" tw-class="w-full rounded-xl border border-gray-200 bg-gray-50/70 py-2.5 pl-9 pr-3 text-xs text-gray-800 outline-none transition-shadow placeholder:text-gray-400 focus:ring-4 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-800/30 dark:text-gray-100" />
                  </div>
                  <ul data-testid="candidate-list" tw-class="divide-y divide-gray-100 dark:divide-gray-800">
                    <li v-for="candidate in filteredCandidates" :key="candidate.id">
                      <button type="button" :data-testid="'discovery-candidate-' + candidate.id" :tw-class="['group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', candidate.current ? 'bg-blue-50/70 dark:bg-blue-500/10' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50']" @click="chooseCandidate({ id: candidate.id })">

                        <div tw-class="min-w-0 flex-1 space-y-1">
                          <div tw-class="flex items-baseline gap-2">
                            <p tw-class="min-w-0 flex-1 break-words text-base font-semibold leading-snug tracking-tight text-gray-900 dark:text-gray-100">{{ candidate.name }}</p>
                            <span v-if="candidate.saved" data-testid="model-candidate-saved" tw-class="inline-flex shrink-0 items-center gap-1 rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.ModelDiscoveryPanel__saved() }}</span>

                          </div>
                          <p tw-class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs tabular-nums leading-relaxed text-gray-500 dark:text-gray-400"><span>{{ candidate.developer }}</span><span v-if="candidate.current" data-testid="model-candidate-current" tw-class="text-blue-600 dark:text-blue-400">{{ lazyStrings.ModelDiscoveryPanel__in_use_in_this_chat() }}</span><span>{{ sizeLabel({ bytes: candidate.bytes }) }}</span><span>{{ lazyStrings.llamaCppBrowser__memory_estimate_gib({ memory: String(candidate.memoryGiB) }) }}</span></p>
                        </div>
                        <ChevronRightIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-300 transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-blue-500 dark:text-gray-600 motion-reduce:transition-none" />
                      </button>
                    </li>
                  </ul>
                  <div v-if="!filteredCandidates.length" tw-class="space-y-3 py-8 text-center">
                    <p tw-class="text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelDiscoveryPanel__no_matching_candidates() }}</p>
                    <button type="button" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10" @click="selectTab({ tab: 'hugging-face' })">{{ lazyStrings.ModelDiscoveryPanel__find_on_hugging_face() }}<ArrowRightIcon tw-class="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <div v-show="activeTab === 'hugging-face'" id="hugging-face-panel" :inert="activeTab !== 'hugging-face' || undefined" role="tabpanel" aria-labelledby="hugging-face-tab" tw-class="space-y-6">
                  <section tw-class="space-y-2.5">
                    <label for="hugging-face-repository" tw-class="block text-xs font-semibold text-gray-600 dark:text-gray-300">{{ lazyStrings.ModelDiscoveryPanel__specify_a_repository() }}</label>
                    <div tw-class="flex flex-col gap-2 sm:flex-row">
                      <input id="hugging-face-repository" v-model="repositoryInput" type="text" :aria-invalid="repositoryError" :aria-describedby="repositoryError ? 'repository-error' : 'repository-help'" placeholder="owner/model" data-testid="hugging-face-repository" tw-class="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none transition-all placeholder:text-gray-400 focus:ring-4 focus:ring-blue-500/10 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" @keydown.enter="submitRepositoryFromKeyboard({ event: $event })" />
                      <LlamaCppBrowserModelActionButton :disabled="!repositoryInput.trim()" data-testid="hugging-face-repository-select" size="regular" tw-class="shrink-0" @click="chooseRepository({ input: repositoryInput })"><ArrowRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.ModelDiscoveryPanel__choose() }}</LlamaCppBrowserModelActionButton>
                    </div>
                    <p v-if="repositoryError" id="repository-error" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ lazyStrings.ModelDiscoveryPanel__enter_a_repository_or_model_page_url() }}</p>
                    <p v-else id="repository-help" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelDiscoveryPanel__paste_the_model_page_url() }}</p>
                  </section>
                  <div tw-class="border-t border-gray-100 pt-5 dark:border-gray-800">
                    <component :is="HuggingFaceSearch" v-if="HuggingFaceSearch" :disabled="!open || activeTab !== 'hugging-face' || preview !== undefined" :repository-input="repositoryInput" scroll-owner="parent" @select="chooseRepository({ input: $event })" />
                  </div>
                </div>
                <div v-show="activeTab === 'local-files'" id="local-files-panel" :inert="activeTab !== 'local-files' || undefined" role="tabpanel" aria-labelledby="local-files-tab">

                  <component :is="LocalModels" v-if="LocalModels" :suspended="!open || activeTab !== 'local-files' || preview !== undefined" :inventory="inventorySource" />
                </div>
              </div>
              <footer v-if="activeTab === 'candidates'" tw-class="shrink-0 border-t border-gray-100 px-5 py-3 dark:border-gray-800 sm:px-8">
                <button type="button" data-testid="discovery-more-models" tw-class="group flex min-h-10 w-full items-center justify-between gap-3 rounded-lg text-left text-xs font-medium text-gray-600 transition-colors hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-blue-400" @click="selectTab({ tab: 'hugging-face' })">{{ lazyStrings.ModelDiscoveryPanel__find_other_models_on_hugging_face() }}<ArrowRightIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></button>
              </footer>
            </div>
          </Transition>

          <Transition name="discovery-detail">
            <section v-if="preview && previewModel" key="detail" data-testid="discovery-detail" tw-class="absolute inset-0 flex min-h-0 flex-col">
              <div data-testid="discovery-detail-viewport" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-5 sm:px-8 sm:pt-8">
                <div tw-class="space-y-4">
                  <p tw-class="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400"><span>{{ previewModel.developer }}</span><span v-if="previewCurrent || previewSaved" data-testid="model-preview-availability" tw-class="inline-flex items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-500/10 dark:text-blue-400"><CheckIcon aria-hidden="true" tw-class="h-3 w-3" />{{ previewCurrent ? lazyStrings.ModelDiscoveryPanel__in_use_in_this_chat() : lazyStrings.ModelDiscoveryPanel__saved() }}</span></p>
                  <h3 ref="previewHeading" tabindex="-1" tw-class="text-[clamp(28px,6vw,36px)] font-semibold leading-[1.15] tracking-tight text-gray-900 outline-none dark:text-gray-100 [overflow-wrap:anywhere]">{{ previewModel.name }}</h3>
                  <p tw-class="break-all text-xs leading-relaxed text-gray-400 dark:text-gray-500">{{ previewRepository }}</p>
                  <p tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.llamaCppBrowser__runs_in_your_browser() }}</p>
                </div>
                <BrowserModelPreparation v-if="selectionState" :model="previewModel" entry="discovery" stage="needs-selection" interaction="ready" :variant="preview.variant" :quantization-options="[]" start-status="idle" :error="undefined" :selection-state="selectionState" @confirm-selection="confirmModelLaunchSelection($event)">
                  <template #details><CspMessageHint v-if="!previewSaved" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" /></template>
                </BrowserModelPreparation><div v-else tw-class="mt-8 space-y-5 border-t border-gray-100 pt-6 dark:border-gray-800">
                  <div tw-class="space-y-2.5">
                    <p tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.LlamaCppBrowserModelLaunch__quantization() }}</p>
                    <SettingsSelect v-if="quantizationOptions.length" :model-value="previewHint?.id ?? preview.variant" :options="quantizationOptions" :label="lazyStrings.LlamaCppBrowserModelLaunch__quantization()" :disabled="starting === 'starting'" data-testid="discovery-quantization" @update:model-value="value => selectQuantization({ value })" />
                    <input v-else :value="preview.variant" :disabled="starting === 'starting'" :aria-label="lazyStrings.BrowserModelPreparation__specify_a_quantization()" :placeholder="lazyStrings.BrowserModelPreparation__automatic()" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm" @input="editVariant({ event: $event })" />
                  </div>
                  <dl tw-class="grid grid-cols-2 gap-5">
                    <div tw-class="space-y-2"><dt tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><HardDriveIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelDiscoveryPanel__model_size() }}</dt><dd :key="preview.variant + '-bytes'" class="discovery-metadata" tw-class="text-base font-medium tabular-nums text-gray-800 dark:text-gray-100">{{ sizeLabel({ bytes: previewModel.bytes }) }}</dd></div>
                    <div tw-class="space-y-2"><dt tw-class="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400"><CpuIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.ModelDiscoveryPanel__memory_hint() }}</dt><dd :key="preview.variant + '-memory'" class="discovery-metadata" tw-class="text-base font-medium tabular-nums text-gray-800 dark:text-gray-100">{{ previewModel.memoryGiB === undefined ? lazyStrings.llamaCppBrowser__not_checked() : `${previewModel.memoryGiB} GiB` }}</dd></div>
                  </dl>
                  <p v-if="previewModel.memoryGiB !== undefined" tw-class="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">{{ lazyStrings.ModelDiscoveryPanel__memory_depends_on_context_and_settings() }}</p>
                </div>
                <!-- Keep the original failure and its guidance together in the scrollable message area. -->
                <div v-if="!selectionState" data-testid="discovery-messages">
                  <p v-if="startError && starting === 'idle'" role="alert" tw-class="mt-5 text-xs text-red-600 dark:text-red-400">{{ startError }}</p>
                  <HuggingFaceDownloadFailureHint v-if="!previewSaved && launchState?.status === 'failed' && launchState.problem === 'failed'" :key="launchState.operation" tw-class="mt-2"><LlamaCppBrowserLocalFileRecovery :disabled="interaction === 'blocked'" :accept-local-input="undefined" /></HuggingFaceDownloadFailureHint>
                  <CspMessageHint v-else-if="!previewSaved && !startError" :target="{ kind: 'huggingface-download' }" activity-for-display-only="download" presentation="compact" tw-class="mt-5" />
                </div>
              </div>
              <footer v-if="!selectionState" tw-class="shrink-0 space-y-3 border-t border-gray-100 bg-white px-5 pb-5 pt-4 dark:border-gray-800 dark:bg-gray-900 sm:px-8 sm:pb-6">
                <button type="button" data-testid="discovery-start" :disabled="starting === 'starting' || globalStarting === 'creating'" :aria-busy="starting === 'starting'" class="discovery-start" tw-class="group relative flex min-h-16 w-full items-center justify-center rounded-2xl border border-blue-400/80 bg-white px-14 py-4 text-center text-base font-bold text-gray-900 transition-[border-color,box-shadow,transform] duration-300 hover:border-blue-500 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait dark:border-blue-500/70 dark:bg-gray-800 dark:text-gray-100 motion-reduce:transition-none" @click="startPreview">
                  {{ lazyStrings.SHARED__run_in_your_browser() }}<span aria-hidden="true" tw-class="absolute right-3 grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-white dark:bg-blue-500"><Loader2Icon v-if="starting === 'starting'" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" /><ArrowRightIcon v-else tw-class="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></span>
                </button>
                <p v-if="selectionTarget !== 'chat'" tw-class="text-center text-[11px] text-gray-400 dark:text-gray-500">{{ previewSaved ? lazyStrings.ModelDiscoveryPanel__start_a_new_chat_with_the_saved_model() : lazyStrings.ModelDiscoveryPanel__prepare_this_model_in_a_new_chat() }}</p>
              </footer>
            </section>
          </Transition>
        </div>
      </aside>
    </Transition>
  </Teleport>


</template>

<style scoped>
.discovery-list-enter-active, .discovery-list-leave-active,
.discovery-detail-enter-active, .discovery-detail-leave-active {
  transition: opacity 220ms ease, transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
}
.discovery-list-enter-from, .discovery-list-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}
.discovery-detail-enter-from, .discovery-detail-leave-to {
  opacity: 0;
  transform: translateX(32px);
}
.discovery-metadata {
  animation: discovery-metadata-appear 220ms ease-out;
}
@keyframes discovery-metadata-appear {
  from {
    opacity: 0.25;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.discovery-start {
  box-shadow: 0 2px 4px rgb(15 23 42 / 0.04), 0 12px 24px -14px rgb(37 99 235 / 0.3);
}
.discovery-start:hover {
  box-shadow: 0 3px 6px rgb(15 23 42 / 0.05), 0 16px 28px -14px rgb(37 99 235 / 0.35);
}
@media (prefers-reduced-motion: reduce) {
  .discovery-list-enter-active, .discovery-list-leave-active,
  .discovery-detail-enter-active, .discovery-detail-leave-active {
    transition: none;
  }
  .discovery-metadata {
    animation: none;
  }
}
</style>
