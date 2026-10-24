<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { ChevronDownIcon, CpuIcon, FolderPlusIcon, HardDriveIcon, SearchIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { createModuleLoader } from '@/utils/module-loader';
import { scheduleIdleTask, type ScheduledIdleTask } from '@/utils/idle-task';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { localModelDisplayName } from '@/components/browser-model-presentation';
import { captureDroppedLocalModels, localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';
import LlamaCppBrowserModelImportModes from './LlamaCppBrowserModelImportModes.vue';
import { missingHostModelDirectoryApis } from '@/logic/host-model-directories';
import { useChatBrowserModelPickerTab, type ChatBrowserModelPickerTab } from '@/features/llama-cpp-browser/composables/useChatBrowserModelPickerTab';
// Code prefetch follows Naidan's shared async-component policy. Actual hidden
// UI preparation remains scoped to an open panel, without authorizing actions.
const repositoryLoader = createModuleLoader({ importModule: () => import('./LlamaCppBrowserRepositoryPicker.vue'), onPrefetchError: () => {} });
const savedLoader = createModuleLoader({ importModule: () => import('./LlamaCppBrowserSavedModelPicker.vue'), onPrefetchError: () => {} });
const linkedLoader = createModuleLoader({ importModule: () => import('./LlamaCppBrowserModelImportLinkedFolders.vue'), onPrefetchError: () => {} });
const RepositoryPicker = defineAsyncComponentAndLoadOnMounted({ loader: repositoryLoader.load });
const SavedModelPicker = defineAsyncComponentAndLoadOnMounted({ loader: savedLoader.load });
const LinkedFolders = defineAsyncComponentAndLoadOnMounted({ loader: linkedLoader.load });
const preparedTabs = shallowRef(new Set<ChatBrowserModelPickerTab>());
const mountedTabs = ref(new Set<ChatBrowserModelPickerTab>());
const tabLoadError = ref(false);
const loadingTabs = new Map<ChatBrowserModelPickerTab, { session: object, promise: Promise<void> }>();
let preparationSession: object | undefined;
let scheduledPreparation: ScheduledIdleTask | undefined;

const props = defineProps<{
  state: ChatLocalModelUi, expansion: 'closed' | 'open', availability: 'available' | 'unavailable',
  layout: 'welcome' | 'embedded', scrollMode: 'source' | 'frame', sourceTabsHost: HTMLElement | undefined,
}>();
const emit = defineEmits<{ 'update:expansion': [value: 'closed' | 'open'], 'model-drop-area-active': [] }>();
const panelId = useId();
const repositoryViewport = ref<HTMLElement>();
let repositoryView: 'search' | 'configuration' = 'search';
let repositorySearchScrollTop = 0;

async function changeRepositoryView({ view }: { view: 'search' | 'configuration' }): Promise<void> {
  const viewport = repositoryViewport.value;
  if (viewport === undefined) {
    return;
  }
  switch (view) {
  case 'configuration': repositorySearchScrollTop = viewport.scrollTop;
    break;
  case 'search': break;
  default: {
    const exhaustive: never = view;
    throw new Error(String(exhaustive));
  }
  }
  repositoryView = view;
  await nextTick();
  if (repositoryViewport.value === viewport && repositoryView === view) {
    switch (view) {
    case 'search': viewport.scrollTop = repositorySearchScrollTop;
      break;
    case 'configuration': viewport.scrollTop = 0;
      break;
    default: {
      const exhaustive: never = view;
      throw new Error(String(exhaustive));
    }
    }
  }
}

const reading = computed(() => props.state.operation.value?.phase === 'reading');
const failure = computed(() => {
  const error = props.state.operation.value?.error;
  switch (error) {
  case undefined: return undefined;
  case 'not-empty': return lazyStrings.ChatLocalModelInput__this_chat_already_has_messages();
  case 'unavailable': return lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here();
  case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
  case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full': case 'unsupported-input':
  case 'busy': case 'aborted': case 'worker-failed': case 'audio-model-unsupported': case 'audio-reference-required': case 'audio-reference-invalid': case 'audio-output-empty':
    return lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model();
  default: {
    const exhaustive: never = error;
    return exhaustive;
  }
  }
});

const preference = useChatBrowserModelPickerTab();
const activeTab = ref<ChatBrowserModelPickerTab>(preference.remembered.value);
// Remember the selected file mode as a leaf in the existing preference. Both
// leaves share the Files source tab; opening either one never selects a model.
const fileTab = ref<'files' | 'linked-folders'>('files');
const activeSource = computed(() => sourceTab({ tab: activeTab.value }));
const linkSupported = missingHostModelDirectoryApis().length === 0;
const fileMode = computed(() => {
  const tab = fileTab.value;
  switch (tab) {
  case 'files': return 'temp';
  case 'linked-folders': return 'host';
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
});
const fileModes = computed(() => [
  { mode: 'temp' as const, label: lazyStrings.ChatLocalModelInput__load_model(), availability: 'available' as const },
  { mode: 'host' as const, label: lazyStrings.SHARED__model_import_link_folder(), availability: linkSupported ? 'available' as const : 'unavailable' as const },
]);
const visibleTab = computed(() => {
  switch (props.expansion) {
  case 'open': return activeTab.value;
  case 'closed': return preference.remembered.value;
  default: {
    const exhaustive: never = props.expansion;
    throw new Error(String(exhaustive));
  }
  }
});
const tabs = computed(() => [
  { key: 'files' as const, label: lazyStrings.ChatLocalModelInput__files(), icon: CpuIcon, action: lazyStrings.ChatLocalModelInput__use_local_model_files() },
  { key: 'hugging-face' as const, label: 'Hugging Face', icon: SearchIcon, action: lazyStrings.ChatLocalModelInput__find_a_model_on_hugging_face() },
  { key: 'saved' as const, label: lazyStrings.ChatLocalModelInput__saved_models(), icon: HardDriveIcon, action: lazyStrings.ChatLocalModelInput__use_a_saved_model() },
]);
const currentTab = computed(() => {
  const tab = visibleTab.value;
  switch (tab) {
  case 'linked-folders': return { icon: FolderPlusIcon, action: lazyStrings.SHARED__model_import_link_folder() };
  case 'files': case 'hugging-face': case 'saved': return tabs.value.find(choice => choice.key === tab)!;
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
});
const disabled = computed(() => props.availability === 'unavailable' || props.state.operation.value !== undefined);
watch(() => props.expansion, async expansion => {
  scheduledPreparation?.cancel();
  preparationSession = undefined;
  switch (expansion) {
  case 'open': {
    const remembered = preference.remembered.value;
    activeTab.value = remembered;
    switch (remembered) {
    case 'files': case 'linked-folders': fileTab.value = remembered;
      break;
    case 'hugging-face': case 'saved': break;
    default: {
      const exhaustive: never = remembered;
      throw new Error(String(exhaustive));
    }
    }
    const session = {};
    preparationSession = session;
    await loadActiveTab();
    await nextTick();
    if (props.expansion === 'open' && preparationSession === session) {
      scheduleTabPreparation({ session, tabs: ['hugging-face', 'saved', 'linked-folders'] });
    }
    break;
  }
  case 'closed': break;
  default: {
    const exhaustive: never = expansion;
    throw new Error(String(exhaustive));
  }
  }
}, { immediate: true });

async function prepareTab({ tab, session }: { tab: ChatBrowserModelPickerTab, session: object }): Promise<void> {
  if (props.expansion !== 'open' || preparationSession !== session) {
    return;
  }
  switch (tab) {
  case 'files': return;
  case 'hugging-face': case 'saved': case 'linked-folders': break;
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
  if (preparedTabs.value.has(tab)) {
    return;
  }
  const prior = loadingTabs.get(tab);
  if (prior?.session === session) {
    return prior.promise;
  }
  const pending = (async () => {
    try {
      switch (tab) {
      case 'hugging-face': await repositoryLoader.load();
        break;
      case 'saved': await savedLoader.load();
        break;
      case 'linked-folders': await linkedLoader.load();
        break;
      default: {
        const exhaustive: never = tab;
        throw new Error(String(exhaustive));
      }
      }
      // Imports cannot be cancelled. Only this open session may mount late UI.
      if (props.expansion !== 'open' || preparationSession !== session) {
        return;
      }
      preparedTabs.value = new Set(preparedTabs.value).add(tab);
    } catch {
      if (props.expansion === 'open' && preparationSession === session && activeTab.value === tab) {
        tabLoadError.value = true;
      }
    } finally {
      if (loadingTabs.get(tab)?.session === session) {
        loadingTabs.delete(tab);
      }
    }
  })();
  loadingTabs.set(tab, { session, promise: pending });
  await pending;
}

function markTabMounted({ tab }: { tab: ChatBrowserModelPickerTab }): void {
  mountedTabs.value.add(tab);
}

async function loadActiveTab(): Promise<void> {
  tabLoadError.value = false;
  if (preparationSession !== undefined) {
    await prepareTab({ tab: activeTab.value, session: preparationSession });
  }
}

function scheduleTabPreparation({ session, tabs }: { session: object, tabs: ChatBrowserModelPickerTab[] }): void {
  scheduledPreparation = scheduleIdleTask({
    timeoutMs: 1500,
    fallbackDelayMs: 120,
    task: async () => {
      if (props.expansion !== 'open' || preparationSession !== session) {
        return;
      }
      const [tab, ...remaining] = tabs;
      if (tab === undefined) {
        return;
      }
      // Prepare strings and disabled UI only. Hidden search and inventory pickers
      // do no network/file scans; linked folders only inspect saved handle state.
      await prepareTab({ tab, session });
      await nextTick();
      if (props.expansion === 'open' && preparationSession === session && remaining.length) {
        scheduleTabPreparation({ session, tabs: remaining });
      }
    },
  });
}

onUnmounted(() => {
  preparationSession = undefined;
  scheduledPreparation?.cancel();
});

function toggleExpansion(): void {
  switch (props.expansion) {
  case 'open': emit('update:expansion', 'closed');
    break;
  case 'closed': emit('update:expansion', 'open');
    break;
  default: {
    const exhaustive: never = props.expansion;
    throw new Error(String(exhaustive));
  }
  }
}

function sourceTab({ tab }: { tab: ChatBrowserModelPickerTab }): 'files' | 'hugging-face' | 'saved' {
  switch (tab) {
  case 'files': case 'linked-folders': return 'files';
  case 'hugging-face': case 'saved': return tab;
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
}

function selectTab({ tab, focus }: { tab: 'files' | 'hugging-face' | 'saved', focus: boolean }): void {
  if (disabled.value) {
    return;
  }
  let next: ChatBrowserModelPickerTab;
  switch (tab) {
  case 'files': next = fileTab.value;
    break;
  case 'hugging-face': case 'saved': next = tab;
    break;
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
  activeTab.value = next;
  void loadActiveTab();
  // Storage reports persistence errors; switching the visible source is immediate.
  void preference.remember({ tab: next }).catch(() => {});
  if (focus) {
    document.getElementById(`${panelId}-${tab}-tab`)?.focus();
  }
}

function selectFileMode({ mode }: { mode: 'opfs' | 'host' | 'temp' }): void {
  if (disabled.value) {
    return;
  }
  switch (mode) {
  case 'temp': fileTab.value = 'files';
    break;
  case 'host': fileTab.value = 'linked-folders';
    break;
  case 'opfs': return;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
  selectTab({ tab: 'files', focus: false });
}

function tabKeydown({ event }: { event: KeyboardEvent }): void {
  const index = tabs.value.findIndex(tab => tab.key === activeSource.value);
  let next: number;
  switch (event.key) {
  case 'ArrowRight': next = (index + 1) % tabs.value.length;
    break;
  case 'ArrowLeft': next = (index + tabs.value.length - 1) % tabs.value.length;
    break;
  case 'Home': next = 0;
    break;
  case 'End': next = tabs.value.length - 1;
    break;
  default: return;
  }
  event.preventDefault();
  selectTab({ tab: tabs.value[next]!.key, focus: true });
}

function chooseLocal({ event, selection }: { event: Event, selection: 'files' | 'directory' }): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }
  const files = Array.from(event.target.files ?? []);
  event.target.value = '';
  if (files.length === 0) {
    return;
  }
  const controller = new AbortController();
  // accept reserves the chat synchronously, before file parsing can yield.
  void props.state.accept({ directories: Promise.resolve().then(() => localModelDirectoriesFromFiles({ files, selection })), controller });
}

function dropLocal({ event }: { event: DragEvent }): void {
  emit('model-drop-area-active');
  if (!event.dataTransfer?.types.includes('Files')) {
    return;
  }
  const controller = new AbortController();
  // Capture entries during dispatch; never await a lazy import first.
  const directories = captureDroppedLocalModels({ transfer: event.dataTransfer, signal: controller.signal });
  void props.state.accept({ directories, controller });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="chat-local-model-input" :class="{ 'chat-model-input-embedded': layout === 'embedded', 'chat-model-input-frame-scroll': scrollMode === 'frame' }" :style="{ '--chat-model-source-overflow': scrollMode === 'frame' ? 'visible' : 'auto' }" tw-class="flex max-h-full min-h-0 w-full max-w-4xl flex-col items-center pointer-events-auto text-center">
    <button
      v-if="layout === 'welcome'"
      type="button"
      :disabled="state.operation.value !== undefined"
      :aria-expanded="expansion === 'open'"
      :aria-controls="panelId"
      data-testid="chat-open-local-model"
      :tw-class="['group inline-flex min-h-9 max-w-full shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors duration-300 motion-reduce:transition-none hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-800 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500', expansion === 'open' ? 'text-gray-800 dark:text-gray-200' : 'text-gray-500 dark:text-gray-400']"
      @click="toggleExpansion"
    >
      <component :is="currentTab.icon" aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 transition-colors duration-300 motion-reduce:transition-none', expansion === 'open' ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500']" />
      <span data-testid="chat-model-picker-label" tw-class="min-w-0 truncate whitespace-nowrap">{{ currentTab.action }}</span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 transition-[transform,color] duration-300 motion-reduce:transition-none', expansion === 'open' ? 'rotate-180 text-blue-500 dark:text-blue-400' : 'text-gray-400']" />
    </button>
    <div :id="panelId" class="chat-model-expander" :inert="expansion === 'closed' || undefined" :aria-hidden="expansion === 'closed'" :tw-class="['grid min-h-0 w-full transition-[grid-template-rows,opacity] duration-350 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none', expansion === 'open' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0']">
      <div class="chat-model-expander-content" tw-class="min-h-0 overflow-hidden">
        <section class="chat-model-content" tw-class="flex h-full min-h-0 flex-col gap-3 pt-4 text-left">
          <div v-show="state.operation.value === undefined || (layout === 'welcome' && state.operation.value.downloadJobId === undefined)" class="chat-model-sources">
            <Teleport :to="sourceTabsHost ?? 'body'" :disabled="layout === 'welcome' || sourceTabsHost === undefined">
              <div v-show="layout === 'welcome' || sourceTabsHost !== undefined" role="tablist" :aria-label="lazyStrings.ChatLocalModelInput__model_source()" tw-class="relative mx-auto grid w-full max-w-sm shrink-0 grid-cols-3 border-b border-gray-100 dark:border-gray-800" @keydown="tabKeydown({ event: $event })">
                <button v-for="tab in tabs" :id="`${panelId}-${tab.key}-tab`" :key="tab.key" type="button" role="tab" :aria-controls="`${panelId}-${tab.key}-panel`" :aria-selected="activeSource === tab.key" :tabindex="activeSource === tab.key ? 0 : -1" :disabled="disabled" :data-testid="`chat-model-tab-${tab.key}`" :tw-class="['inline-flex min-h-10 items-center justify-center gap-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', activeSource === tab.key ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']" @click="selectTab({ tab: tab.key, focus: false })">{{ tab.label }}</button>
                <span aria-hidden="true" :tw-class="['pointer-events-none absolute bottom-0 left-0 h-0.5 w-1/3 rounded-full bg-blue-500 transition-transform duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none', activeSource === 'files' ? 'translate-x-0' : activeSource === 'hugging-face' ? 'translate-x-full' : 'translate-x-[200%]']" />
              </div>
            </Teleport>
            <div data-testid="chat-model-source-viewport" class="chat-model-source-viewport" tw-class="relative h-[min(34rem,60dvh)] min-h-0 overflow-hidden">
              <div v-if="tabLoadError" role="alert" data-testid="chat-model-tab-load-error" tw-class="absolute inset-x-1 top-1 z-10 flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-white px-3 py-2 text-xs text-red-600 dark:border-red-500/30 dark:bg-gray-900 dark:text-red-400"><span>{{ lazyStrings.useAppEntry__could_not_open_model_browser() }}</span><button type="button" tw-class="min-h-8 shrink-0 rounded-lg px-2 font-medium hover:bg-red-50 dark:hover:bg-red-500/10 focus-visible:outline-2 focus-visible:outline-blue-500" @click="loadActiveTab">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button></div>
              <div data-testid="chat-model-source-panels" class="chat-model-source-panels" tw-class="relative h-full">
                <div :id="`${panelId}-files-panel`" role="tabpanel" :aria-labelledby="`${panelId}-files-tab`" :inert="activeSource !== 'files' || undefined" :aria-hidden="activeSource !== 'files'" :tw-class="['absolute inset-0 flex flex-col gap-3 overflow-hidden px-1 transition-opacity duration-180 ease-out motion-reduce:transition-none', activeSource === 'files' ? 'opacity-100' : 'pointer-events-none opacity-0']" data-testid="chat-local-model-drop-zone">
                  <LlamaCppBrowserModelImportModes :model-value="fileMode" :modes="fileModes" :disabled="disabled || expansion === 'closed' || activeSource !== 'files'" tw-class="mx-auto w-full max-w-sm shrink-0" @update:model-value="selectFileMode({ mode: $event })" />
                  <div class="chat-model-file-views" tw-class="relative min-h-0 flex-1">
                    <div :inert="fileTab !== 'files' || undefined" :aria-hidden="fileTab !== 'files'" :tw-class="['absolute inset-0 overflow-y-auto overscroll-contain transition-opacity duration-180 ease-out motion-reduce:transition-none', fileTab === 'files' ? 'opacity-100' : 'pointer-events-none opacity-0']">
                      <LlamaCppBrowserModelFileInput :disabled="disabled || expansion === 'closed' || activeTab !== 'files'" mode="temp" :layout="layout === 'embedded' ? 'fill' : 'expanded'" :description="lazyStrings.ChatLocalModelInput__start_without_copying_and_save_later()" @files="chooseLocal({ event: $event, selection: 'files' })" @directory="chooseLocal({ event: $event, selection: 'directory' })" @drop-files="dropLocal({ event: $event })" @drag-active="emit('model-drop-area-active')" />
                    </div>
                    <div data-testid="chat-linked-folders-panel" :inert="fileTab !== 'linked-folders' || undefined" :aria-hidden="fileTab !== 'linked-folders'" :tw-class="['absolute inset-0 space-y-3 overflow-y-auto overscroll-contain transition-opacity duration-180 ease-out motion-reduce:transition-none', fileTab === 'linked-folders' ? 'opacity-100' : 'pointer-events-none opacity-0']">
                      <div tw-class="mx-auto w-full max-w-xl">
                        <LinkedFolders v-if="preparedTabs.has('linked-folders') && (expansion === 'open' || mountedTabs.has('linked-folders'))" @vue:mounted="markTabMounted({ tab: 'linked-folders' })" :disabled="disabled || expansion === 'closed' || activeTab !== 'linked-folders'" />
                      </div>
                    </div>
                  </div>
                </div>
                <div :id="`${panelId}-hugging-face-panel`" ref="repositoryViewport" role="tabpanel" :aria-labelledby="`${panelId}-hugging-face-tab`" :inert="activeTab !== 'hugging-face' || undefined" :aria-hidden="activeTab !== 'hugging-face'" :tw-class="['absolute inset-0 overflow-y-auto overscroll-contain px-1 transition-opacity duration-180 ease-out motion-reduce:transition-none', activeTab === 'hugging-face' ? 'opacity-100' : 'pointer-events-none opacity-0']"><RepositoryPicker v-if="preparedTabs.has('hugging-face') && (expansion === 'open' || mountedTabs.has('hugging-face'))" @vue:mounted="markTabMounted({ tab: 'hugging-face' })" :disabled="disabled || expansion === 'closed' || activeTab !== 'hugging-face'" @view-change="changeRepositoryView({ view: $event })" @select="state.useRepositoryModel($event)" @select-model="state.useModel({ model: $event })" /></div>
                <div :id="`${panelId}-saved-panel`" role="tabpanel" :aria-labelledby="`${panelId}-saved-tab`" :inert="activeTab !== 'saved' || undefined" :aria-hidden="activeTab !== 'saved'" :tw-class="['absolute inset-0 overflow-hidden px-1 transition-opacity duration-180 ease-out motion-reduce:transition-none', activeTab === 'saved' ? 'opacity-100' : 'pointer-events-none opacity-0']"><SavedModelPicker v-if="preparedTabs.has('saved') && (expansion === 'open' || mountedTabs.has('saved'))" @vue:mounted="markTabMounted({ tab: 'saved' })" :disabled="disabled || expansion === 'closed' || activeTab !== 'saved'" @select="state.useModel({ model: $event })" @source="selectTab({ tab: $event, focus: true })" /></div>
              </div>
            </div>
          </div>
          <p v-if="availability === 'unavailable'" role="status" tw-class="text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here() }}</p>
          <div v-if="state.operation.value !== undefined" class="chat-model-operation">
            <div v-if="state.operation.value?.downloadJobId !== undefined" data-testid="chat-model-download" tw-class="space-y-4 rounded-xl border border-gray-100 px-4 py-5 dark:border-gray-800">
              <p tw-class="break-words text-sm font-semibold text-gray-800 dark:text-gray-100">{{ state.downloadJob.value?.repository }}</p>
              <LlamaCppBrowserDownloadProgress :progress="state.downloadJob.value?.progress" appearance="welcome" :activity="state.operation.value.phase === 'downloading' ? 'active' : 'inactive'" />
              <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ChatLocalModelInput__write_your_first_message_while_the_model_downloads() }}</p>
              <button v-if="state.operation.value.phase === 'downloading'" type="button" data-testid="chat-model-download-pause" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="state.pauseDownload()">{{ lazyStrings.ChatLocalModelInput__pause_download() }}</button>
            </div>
            <p v-if="reading" role="status" tw-class="flex items-center justify-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3 w-3 animate-spin motion-reduce:animate-none" />{{ lazyStrings.ChatLocalModelInput__checking_files() }}</p>
            <div v-if="state.operation.value?.phase === 'choosing'" data-testid="chat-local-model-candidates" class="chat-model-candidates" tw-class="max-h-48 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700">
              <p tw-class="px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.LocalModelSelectionDialog__choose_a_model_configuration() }}</p>
              <button v-for="candidate in state.operation.value.candidates" :key="candidate.modelId" type="button" tw-class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="state.choose({ modelId: candidate.modelId })"><span tw-class="min-w-0 truncate">{{ localModelDisplayName({ model: candidate }) }}</span><span tw-class="shrink-0 tabular-nums text-gray-400">{{ formatDownloadBytes({ bytes: candidate.size }) }}</span></button>
            </div>
            <p v-if="failure" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ failure }}</p>
            <button v-if="state.operation.value?.phase === 'error'" type="button" data-testid="chat-local-model-retry" tw-class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500" @click="state.retry()">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
            <button v-if="state.operation.value" type="button" :disabled="state.operation.value.phase === 'cancelling' || state.operation.value.phase === 'committing'" data-testid="chat-local-model-cancel" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="state.cancel()">{{ lazyStrings.SHARED__cancel() }}</button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-model-sources, .chat-model-operation {
  display: contents;
}
.chat-model-input-embedded .chat-model-operation {
  display: block;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.chat-model-input-embedded .chat-model-operation > * + * {
  margin-top: 12px;
}
.chat-model-input-embedded .chat-model-candidates {
  max-height: none;
  overflow: visible;
}
.chat-model-input-embedded {
  height: 100%;
}
.chat-model-input-embedded .chat-model-expander,
.chat-model-input-embedded .chat-model-expander-content {
  flex: 1;
  height: 100%;
}
.chat-model-input-embedded .chat-model-content {
  gap: 10px;
  padding-top: 4px;
}
.chat-model-input-embedded .chat-model-source-viewport {
  flex: 1;
  height: auto;
}
.chat-model-source-panels > [role="tabpanel"],
.chat-model-file-views > div {
  overflow-y: var(--chat-model-source-overflow, auto);
}
/* The saved list owns scrolling inside its fixed panel. */
.chat-model-source-panels > [role="tabpanel"]:first-child,
.chat-model-source-panels > [role="tabpanel"]:last-child {
  overflow: hidden;
}
.chat-model-input-frame-scroll,
.chat-model-input-frame-scroll .chat-model-expander,
.chat-model-input-frame-scroll .chat-model-expander-content,
.chat-model-input-frame-scroll .chat-model-content,
.chat-model-input-frame-scroll .chat-model-source-viewport,
.chat-model-input-frame-scroll .chat-model-source-panels,
.chat-model-input-frame-scroll .chat-model-file-views {
  height: auto;
  max-height: none;
  overflow: visible;
}
.chat-model-input-frame-scroll .chat-model-source-panels > [role="tabpanel"],
.chat-model-input-frame-scroll .chat-model-file-views > div {
  position: relative;
  inset: auto;
  overflow: visible;
}
.chat-model-input-frame-scroll .chat-model-operation {
  overflow: visible;
}
.chat-model-input-frame-scroll [aria-hidden="true"] {
  display: none;
}
</style>
