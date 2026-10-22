<script setup lang="ts">
import { computed, defineAsyncComponent, ref, shallowRef, useId, watch } from 'vue';
import { ChevronDownIcon, CpuIcon, HardDriveIcon, SearchIcon, Loader2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { localModelDisplayName } from '@/components/browser-model-presentation';
import { captureDroppedLocalModels, localModelDirectoriesFromFiles } from '@/features/llama-cpp-browser/logic/local-model-input';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';
import LlamaCppBrowserDownloadProgress from './LlamaCppBrowserDownloadProgress.vue';
import { useChatBrowserModelPickerTab, type ChatBrowserModelPickerTab } from '@/features/llama-cpp-browser/composables/useChatBrowserModelPickerTab';
const RepositoryPicker = defineAsyncComponent(() => import('./LlamaCppBrowserRepositoryPicker.vue'));
const SavedModelPicker = defineAsyncComponent(() => import('./LlamaCppBrowserSavedModelPicker.vue'));

const props = defineProps<{ state: ChatLocalModelUi, expansion: 'closed' | 'open', availability: 'available' | 'unavailable' }>();
const emit = defineEmits<{ 'update:expansion': [value: 'closed' | 'open'], 'model-drop-area-active': [] }>();
const panelId = useId();
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
const visited = shallowRef(new Set<ChatBrowserModelPickerTab>());
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
const currentTab = computed(() => tabs.value.find(tab => tab.key === visibleTab.value)!);
const disabled = computed(() => props.availability === 'unavailable' || props.state.operation.value !== undefined);
watch(() => props.expansion, expansion => {
  switch (expansion) {
  case 'open':
    activeTab.value = preference.remembered.value;
    visited.value = new Set(visited.value).add(activeTab.value);
    break;
  case 'closed': break;
  default: {
    const exhaustive: never = expansion;
    throw new Error(String(exhaustive));
  }
  }
}, { immediate: true });

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

function selectTab({ tab, focus }: { tab: ChatBrowserModelPickerTab, focus: boolean }): void {
  if (disabled.value) {
    return;
  }
  activeTab.value = tab;
  visited.value = new Set(visited.value).add(tab);
  // Storage reports persistence errors; switching the visible source is immediate.
  void preference.remember({ tab }).catch(() => {});
  if (focus) {
    document.getElementById(`${panelId}-${tab}-tab`)?.focus();
  }
}

function tabKeydown({ event }: { event: KeyboardEvent }): void {
  const index = tabs.value.findIndex(tab => tab.key === activeTab.value);
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
  <div data-testid="chat-local-model-input" tw-class="w-full max-w-4xl pointer-events-auto text-center">
    <button type="button" :disabled="state.operation.value !== undefined" :aria-expanded="expansion === 'open'" :aria-controls="panelId" data-testid="chat-open-local-model" tw-class="group inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500" @click="toggleExpansion"><component :is="currentTab.icon" aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" /><span data-testid="chat-model-picker-label" tw-class="min-w-0 truncate whitespace-nowrap">{{ currentTab.action }}</span><ChevronDownIcon aria-hidden="true" :tw-class="['h-3 w-3 text-gray-400 transition-transform duration-300 motion-reduce:transition-none', expansion === 'open' ? 'rotate-180' : '']" /></button>
    <div :id="panelId" :inert="expansion === 'closed' || undefined" :aria-hidden="expansion === 'closed'" :tw-class="['grid transition-[grid-template-rows,opacity] duration-350 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none', expansion === 'open' ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0']">
      <div tw-class="min-h-0 overflow-hidden">
        <section tw-class="mt-4 space-y-3 text-left">
          <div v-if="state.operation.value?.downloadJobId !== undefined" data-testid="chat-model-download" tw-class="space-y-4 rounded-xl border border-gray-100 px-4 py-5 dark:border-gray-800">
            <p tw-class="break-words text-sm font-semibold text-gray-800 dark:text-gray-100">{{ state.downloadJob.value?.repository }}</p>
            <LlamaCppBrowserDownloadProgress :progress="state.downloadJob.value?.progress" appearance="welcome" :activity="state.operation.value.phase === 'downloading' ? 'active' : 'inactive'" />
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ChatLocalModelInput__write_your_first_message_while_the_model_downloads() }}</p>
            <button v-if="state.operation.value.phase === 'downloading'" type="button" data-testid="chat-model-download-pause" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="state.pauseDownload()">{{ lazyStrings.ChatLocalModelInput__pause_download() }}</button>
          </div>
          <template v-else>
            <div role="tablist" :aria-label="lazyStrings.ChatLocalModelInput__model_source()" tw-class="relative mx-auto grid w-full max-w-sm grid-cols-3 border-b border-gray-100 dark:border-gray-800" @keydown="tabKeydown({ event: $event })">
              <button v-for="tab in tabs" :id="`${panelId}-${tab.key}-tab`" :key="tab.key" type="button" role="tab" :aria-controls="`${panelId}-${tab.key}-panel`" :aria-selected="activeTab === tab.key" :tabindex="activeTab === tab.key ? 0 : -1" :disabled="disabled" :data-testid="`chat-model-tab-${tab.key}`" :tw-class="['inline-flex min-h-10 items-center justify-center gap-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', activeTab === tab.key ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']" @click="selectTab({ tab: tab.key, focus: false })">{{ tab.label }}</button>
              <span aria-hidden="true" :tw-class="['pointer-events-none absolute bottom-0 left-0 h-0.5 w-1/3 rounded-full bg-blue-500 transition-transform duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none', activeTab === 'files' ? 'translate-x-0' : activeTab === 'hugging-face' ? 'translate-x-full' : 'translate-x-[200%]']" />
            </div>
            <div data-testid="chat-model-source-viewport" tw-class="relative h-[min(24rem,42dvh)] min-h-0 overflow-hidden">
              <div data-testid="chat-model-source-panels" tw-class="relative h-full">
                <div :id="`${panelId}-files-panel`" role="tabpanel" :aria-labelledby="`${panelId}-files-tab`" :inert="activeTab !== 'files' || undefined" :aria-hidden="activeTab !== 'files'" :tw-class="['absolute inset-0 overflow-y-auto overscroll-contain px-1 transition-opacity duration-180 ease-out motion-reduce:transition-none', activeTab === 'files' ? 'opacity-100' : 'pointer-events-none opacity-0']" data-testid="chat-local-model-drop-zone">
                  <LlamaCppBrowserModelFileInput :disabled="disabled || expansion === 'closed' || activeTab !== 'files'" mode="temp" layout="expanded" :description="lazyStrings.ChatLocalModelInput__start_without_copying_and_save_later()" @files="chooseLocal({ event: $event, selection: 'files' })" @directory="chooseLocal({ event: $event, selection: 'directory' })" @drop-files="dropLocal({ event: $event })" @drag-active="emit('model-drop-area-active')" />
                </div>
                <div :id="`${panelId}-hugging-face-panel`" role="tabpanel" :aria-labelledby="`${panelId}-hugging-face-tab`" :inert="activeTab !== 'hugging-face' || undefined" :aria-hidden="activeTab !== 'hugging-face'" :tw-class="['absolute inset-0 overflow-y-auto overscroll-contain px-1 transition-opacity duration-180 ease-out motion-reduce:transition-none', activeTab === 'hugging-face' ? 'opacity-100' : 'pointer-events-none opacity-0']"><RepositoryPicker v-if="visited.has('hugging-face')" :disabled="disabled || expansion === 'closed' || activeTab !== 'hugging-face'" @select="state.useRepositoryModel({ target: $event })" /></div>
                <div :id="`${panelId}-saved-panel`" role="tabpanel" :aria-labelledby="`${panelId}-saved-tab`" :inert="activeTab !== 'saved' || undefined" :aria-hidden="activeTab !== 'saved'" :tw-class="['absolute inset-0 overflow-hidden px-1 transition-opacity duration-180 ease-out motion-reduce:transition-none', activeTab === 'saved' ? 'opacity-100' : 'pointer-events-none opacity-0']"><SavedModelPicker v-if="visited.has('saved')" :disabled="disabled || expansion === 'closed' || activeTab !== 'saved'" @select="state.useModel({ model: $event })" @source="selectTab({ tab: $event, focus: true })" /></div>
              </div>
            </div>
          </template>
          <p tw-class="text-center text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.ChatLocalModelInput__use_in_this_chat() }}</p>
          <p v-if="availability === 'unavailable'" role="status" tw-class="text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here() }}</p>
          <p v-if="reading" role="status" tw-class="flex items-center justify-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3 w-3 animate-spin motion-reduce:animate-none" />{{ lazyStrings.ChatLocalModelInput__checking_files() }}</p>
          <div v-if="state.operation.value?.phase === 'choosing'" data-testid="chat-local-model-candidates" tw-class="max-h-48 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700">
            <p tw-class="px-3 py-2 text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.LocalModelSelectionDialog__choose_a_model_configuration() }}</p>
            <button v-for="candidate in state.operation.value.candidates" :key="candidate.modelId" type="button" tw-class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500" @click="state.choose({ modelId: candidate.modelId })"><span tw-class="min-w-0 truncate">{{ localModelDisplayName({ model: candidate }) }}</span><span tw-class="shrink-0 tabular-nums text-gray-400">{{ formatDownloadBytes({ bytes: candidate.size }) }}</span></button>
          </div>
          <p v-if="failure" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ failure }}</p>
          <button v-if="state.operation.value?.phase === 'error'" type="button" data-testid="chat-local-model-retry" tw-class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500" @click="state.retry()">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
          <button v-if="state.operation.value" type="button" :disabled="state.operation.value.phase === 'cancelling' || state.operation.value.phase === 'committing'" data-testid="chat-local-model-cancel" tw-class="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="state.cancel()">{{ lazyStrings.SHARED__cancel() }}</button>
        </section>
      </div>
    </div>
  </div>
</template>
