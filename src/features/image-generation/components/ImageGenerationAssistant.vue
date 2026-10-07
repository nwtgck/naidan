<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onScopeDispose, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { ExternalLinkIcon, UnplugIcon, XIcon, PanelRightIcon, PanelsTopLeftIcon, InfoIcon, ChevronDownIcon } from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import { useChatListData } from '@/composables/chat/ui/useChatListData';
import { chatDataStore } from '@/composables/chat/global/chat-core-singletons';
import { idToRaw, type ChatId, type ImageGenerationBindingId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import { trapImageDialogFocus } from '@/features/image-generation/dialog-keyboard';
import ImageGenerationChatPicker from './ImageGenerationChatPicker.vue';
import { lazyStrings } from '@/strings';
import { registerImageGenerationAssistant } from '@/features/image-generation/session/assistant-registry';
import { createImageGenerationAssistantTools } from '@/features/image-generation/session/assistant-tools';
import type { ImageGenerationPromptTarget } from '@/features/image-generation/session/prompt-access';
import type { ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
const props = defineProps<{ workspace: ImageGenerationWorkspaceView, active: boolean, presentation?: 'floating' | 'docked', id?: string }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const docked = computed(() => props.presentation === 'docked');
const helpOpen = ref(false);
let previousFocus: HTMLElement | undefined;
watch(() => props.active, async (active, _previous, onCleanup) => {
  let current = true; onCleanup(() => {
    current = false;
  });
  if (!active) {
    if (previousFocus?.isConnected && panel.value?.contains(document.activeElement)) previousFocus.focus({ preventScroll: true });
    return;
  }
  if (document.activeElement instanceof HTMLElement) previousFocus = document.activeElement;
  await nextTick();
  if (current) panel.value?.focus({ preventScroll: true });
}, { immediate: true });
function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (!docked.value) trapImageDialogFocus({ root: panel.value, event });
  if (event.key === 'Escape' && !docked.value) {
    event.preventDefault(); emit('close');
  }
}
const ChatPane = defineAsyncComponent(() => import('@/components/ChatPane.vue'));
const { chats } = useChatListData();
const selected = computed(() => props.workspace.currentSession.value?.assistantChatId), loaded = ref<ChatId>(), loading = ref(false), failure = ref('');
const pickerOpen = ref(true);
async function chooseChat({ chatId }: { chatId: ChatId | undefined }): Promise<void> {
  await props.workspace.connectChat({ chatId });
}
watch(() => props.workspace.currentSession.value?.assistantChatId, chatId => {
  pickerOpen.value = !chatId;
}, { immediate: true });
let disposed = false, loadingEpoch = 0;
const identity = computed(() => [props.active, loaded.value, props.workspace.store.value?.storeId, props.workspace.selectedSessionId.value] as const);
watch([selected, () => chats.value.some(chat => chat.id === selected.value)], async ([chatId, listed]) => {
  const token = ++loadingEpoch;
  loaded.value = undefined; failure.value = ''; loading.value = false;
  if (!chatId) return;
  if (!listed) {
    failure.value = 'The selected chat is unavailable.'; return;
  }
  loading.value = true;
  try {
    const existing = chatDataStore.getLiveChatById({ chatId });
    const chat = existing ?? await storageService.loadChat({ id: chatId });
    if (disposed || token !== loadingEpoch) return;
    if (!chat || !chats.value.some(choice => choice.id === chatId)) throw new Error('The selected chat is unavailable.');
    chatDataStore.getLiveChat({ chat });
    loaded.value = chatId;
  } catch (error) {
    if (token === loadingEpoch) failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (token === loadingEpoch) loading.value = false;
  }
}, { immediate: true });
watch(identity, ([active, chatId, storeId, sessionId], _previous, onCleanup) => {
  if (!active || !chatId || !storeId || !sessionId) return;
  const bound = { chatId, storeId, sessionId };
  const bindingId = generateId<ImageGenerationBindingId>(), lifetime = new AbortController();
  function readTarget(): ImageGenerationPromptTarget | undefined {
    const view = props.workspace;
    if (lifetime.signal.aborted || !props.active || loaded.value !== chatId || view.store.value?.storeId !== storeId
      || view.selectedSessionId.value !== sessionId || !view.editorReady.value || view.editor.draftDisabled.value) return undefined;
    return {
      ...bound,
      bindingId,
      revision: view.draftRevision.value,
      prompt: view.editor.parameters.value.prompt,
      negativePrompt: view.editor.parameters.value.negativePrompt,
    };
  }
  try {
    const unregister = registerImageGenerationAssistant({
      chatId,
      create: () => createImageGenerationAssistantTools({
        chatId,
        bindingSignal: lifetime.signal,
        readTarget,
        readContext() {
          const view = props.workspace, parameters = view.editor.parameters.value;
          const model = view.editor.library.models.value.find(choice => choice.id === view.editor.library.main.value);
          return {
            sessionTitle: view.currentSession.value?.title ?? '',
            model: model?.label ?? '',
            width: parameters.width,
            height: parameters.height,
            steps: parameters.steps,
            guidance: parameters.guidance,
            count: view.count.value,
          };
        },
        commit({ expected, edit }) {
          const current = readTarget();
          if (!current || current.bindingId !== expected.bindingId || current.revision !== expected.revision || current.prompt !== expected.prompt || current.negativePrompt !== expected.negativePrompt) return 'conflict';
          return props.workspace.setPromptDraft(edit) ? 'applied' : 'conflict';
        },
      }),
    });
    onCleanup(() => {
      lifetime.abort(); unregister();
    });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error); lifetime.abort();
  }
}, { immediate: true, flush: 'sync' });
const unsubscribe = storageService.subscribeToChanges({
  listener: ({ event }) => {
    switch (event.type) {
    case 'migration': loadingEpoch++; loaded.value = undefined; break;
    case 'chat_meta_and_chat_group': case 'chat_content': case 'chat_content_generation': case 'settings': case 'naidan_rpc_registry': case 'binary_objects': break;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  },
});
onScopeDispose(() => {
  disposed = true; loadingEpoch++; unsubscribe();
  if (props.active && panel.value?.contains(document.activeElement) && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { selected } }) || {}) });
</script>
<template>
  <!-- A dock remains in normal flex layout; it never overlays the preview.
       Moving the Teleport preserves the existing ChatPane instance and draft. -->
  <Teleport to="body" :disabled="docked">
    <div v-show="active" :tw-class="docked ? 'w-[min(28rem,38%)] min-w-80 shrink-0 h-full min-h-0 border-l border-gray-200 dark:border-gray-700' : 'fixed inset-0 z-40 flex justify-end'" :data-testid="docked ? 'workspace-chat-dock' : 'workspace-chat-overlay'">
      <button v-if="!docked" type="button" tabindex="-1" @click="emit('close')" :aria-label="lazyStrings.imageGeneration__close_chat()" tw-class="absolute inset-0 bg-black/30 dark:bg-black/50" />
      <aside :id="id" ref="panel" :role="docked ? 'complementary' : 'dialog'" :aria-modal="docked ? undefined : 'true'" :aria-label="lazyStrings.imageGeneration__assistant()" tabindex="-1" @keydown="keydown({ event: $event })" :tw-class="['relative w-full max-w-full outline-none bg-white dark:bg-gray-900 overflow-hidden flex flex-col h-full min-h-0', docked ? '' : 'sm:w-[30rem] border-l border-gray-200 dark:border-gray-700 shadow-2xl']" data-testid="image-generation-assistant">
        <header tw-class="shrink-0 px-3 py-2 border-b border-gray-100 dark:border-gray-800 space-y-2">
          <div tw-class="flex items-center gap-1">
            <h2 tw-class="sr-only">{{ lazyStrings.imageGeneration__assistant() }}</h2>
            <button type="button" @click="pickerOpen = !pickerOpen" :aria-expanded="pickerOpen" :title="lazyStrings.imageGeneration__change_chat()" data-testid="workspace-chat-picker-toggle" tw-class="min-w-0 flex-1 flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-left font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><span tw-class="min-w-0 truncate">{{ chats.find(chat => chat.id === selected)?.title || (selected ? lazyStrings.SHARED__new_chat() : lazyStrings.imageGeneration__attach_chat()) }}</span><ChevronDownIcon aria-hidden="true" tw-class="w-3.5 h-3.5 shrink-0" /></button>
            <button type="button" @click="workspace.updatePreferences({ change: { type: 'assistant-layout', layout: workspace.assistantLayout.value === 'docked' ? 'floating' : 'docked' } })" :disabled="workspace.busy.value || !workspace.available.value" :aria-pressed="workspace.assistantLayout.value === 'docked'" :title="workspace.assistantLayout.value === 'docked' ? lazyStrings.imageGeneration__float_chat() : lazyStrings.imageGeneration__dock_chat()" :aria-label="workspace.assistantLayout.value === 'docked' ? lazyStrings.imageGeneration__float_chat() : lazyStrings.imageGeneration__dock_chat()" data-testid="workspace-chat-dock-toggle" tw-class="min-h-8 min-w-8 p-1.5 shrink-0 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><PanelsTopLeftIcon v-if="workspace.assistantLayout.value === 'docked'" tw-class="w-4 h-4" /><PanelRightIcon v-else tw-class="w-4 h-4" /></button>
            <button type="button" @click="helpOpen = !helpOpen" :aria-expanded="helpOpen" :title="lazyStrings.imageGeneration__chat_help()" :aria-label="lazyStrings.imageGeneration__chat_help()" data-testid="workspace-chat-help-toggle" tw-class="min-h-8 min-w-8 p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><InfoIcon tw-class="w-4 h-4" /></button>
            <RouterLink v-if="loaded" :to="'/chat/' + idToRaw({ id: loaded })" :title="lazyStrings.imageGeneration__open_chat()" :aria-label="lazyStrings.imageGeneration__open_chat()" tw-class="min-h-8 min-w-8 p-2 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"><ExternalLinkIcon tw-class="w-4 h-4" /></RouterLink>
            <button v-if="selected" type="button" @click="chooseChat({ chatId: undefined })" :disabled="workspace.mutation.value" :title="lazyStrings.imageGeneration__detach()" :aria-label="lazyStrings.imageGeneration__detach()" tw-class="min-h-8 min-w-8 p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40"><UnplugIcon tw-class="w-4 h-4" /></button>
            <button type="button" @click="emit('close')" :aria-label="lazyStrings.imageGeneration__close_chat()" data-testid="workspace-chat-close" tw-class="min-h-8 min-w-8 p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><XIcon tw-class="w-4 h-4" /></button>
          </div>
          <div v-if="pickerOpen && active" tw-class="max-h-[45vh] overflow-y-auto overscroll-contain"><ImageGenerationChatPicker :key="workspace.selectedSessionId.value ? idToRaw({ id: workspace.selectedSessionId.value }) : undefined" :selected="selected" :disabled="!active || workspace.busy.value || loading" @select="chooseChat({ chatId: $event })" /></div>
          <div v-if="helpOpen" data-testid="workspace-chat-help" tw-class="px-2 pb-1 space-y-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400"><p>{{ lazyStrings.imageGeneration__assistant_help() }}</p><p>{{ lazyStrings.imageGeneration__assistant_privacy() }}</p></div>
          <p v-if="loading" role="status" tw-class="text-xs text-gray-500">{{ lazyStrings.imageGeneration__loading() }}</p>
          <p v-if="workspace.failure.value || failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ failure || workspace.failure.value }}</p>
        </header>
        <div v-if="loaded && active" tw-class="flex-1 min-h-0 overflow-hidden"><ChatPane :key="idToRaw({ id: loaded })" :chat-id="loaded" /></div>
        <div v-if="!loaded && !loading" tw-class="p-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400"><p>{{ lazyStrings.imageGeneration__choose_chat_help() }}</p></div>
      </aside>
    </div>
  </Teleport>
</template>
