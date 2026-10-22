<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { CheckIcon, ChevronDownIcon, FolderPlusIcon, GlobeIcon, Loader2Icon } from 'lucide-vue-next';
import MessageActionsMenu from '@/components/MessageActionsMenu.vue';
import { isDefaultLocalModel, type DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { lazyStrings } from '@/strings';

const props = defineProps<{ model: LocalModel, current: DefaultModelContext | undefined, disabled: boolean, defaultActionDisabled: boolean, creating: boolean }>();
const emit = defineEmits<{ createChatGroup: [], selectDefault: [model: LocalModel] }>();
type Action = 'create_chat_group' | 'set_default';
const mode = ref<Action>('create_chat_group');
const open = ref(false);
const id = useId();
const trigger = ref<HTMLButtonElement>();
const main = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const unavailable = computed(() => props.disabled || props.creating);
const selected = computed(() => isDefaultLocalModel({ model: props.model, current: props.current }));
const label = computed(() => {
  switch (mode.value) {
  case 'create_chat_group': return lazyStrings.LlamaCppBrowserModelAction__create_chat_group();
  case 'set_default': return selected.value ? lazyStrings.llamaCppBrowserDownloads__in_use() : lazyStrings.llamaCppBrowserDownloads__set_as_default();
  default: {
    const exhaustive: never = mode.value;
    throw new Error(String(exhaustive));
  }
  }
});

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  open.value = false;
  if (restoreFocus) {
    trigger.value?.focus();
  }
}

async function show({ edge }: { edge: 'selected' | 'first' | 'last' }): Promise<void> {
  if (unavailable.value) {
    return;
  }
  open.value = true;
  await nextTick();
  if (!open.value) {
    return;
  }
  const options = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)') ?? []);
  switch (edge) {
  case 'selected': (options.find(option => option.getAttribute('aria-checked') === 'true') ?? options[0])?.focus();
    break;
  case 'first': options[0]?.focus();
    break;
  case 'last': options.at(-1)?.focus();
    break;
  default: {
    const exhaustive: never = edge;
    throw new Error(String(exhaustive));
  }
  }
}

async function choose({ action }: { action: Action }): Promise<void> {
  if (unavailable.value) {
    return;
  }
  mode.value = action;
  close({ restoreFocus: false });
  await nextTick();
  if (!unavailable.value) {
    (main.value?.disabled ? trigger.value : main.value)?.focus();
  }
}

function execute(): void {
  if (unavailable.value) {
    return;
  }
  close({ restoreFocus: false });
  switch (mode.value) {
  case 'create_chat_group': emit('createChatGroup');
    break;
  case 'set_default':
    if (!props.defaultActionDisabled && !selected.value) {
      emit('selectDefault', props.model);
    }
    break;
  default: {
    const exhaustive: never = mode.value;
    throw new Error(String(exhaustive));
  }
  }
}

function triggerKey({ event }: { event: KeyboardEvent }): void {
  switch (event.key) {
  case 'ArrowDown':
    event.preventDefault();
    void show({ edge: 'first' });
    break;
  case 'ArrowUp':
    event.preventDefault();
    void show({ edge: 'last' });
    break;
  }
}

function menuKey({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close({ restoreFocus: true });
    return;
  }
  if (event.key === 'Tab') {
    // The panel is teleported to body. Return to the trigger before the native
    // Tab movement so focus follows this row instead of the end of the page.
    close({ restoreFocus: true });
    return;
  }
  const options = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)') ?? []);
  const current = options.findIndex(option => option === document.activeElement);
  let next: number;
  switch (event.key) {
  case 'ArrowDown': next = (current + 1) % options.length;
    break;
  case 'ArrowUp': next = (current - 1 + options.length) % options.length;
    break;
  case 'Home': next = 0;
    break;
  case 'End': next = options.length - 1;
    break;
  default: return;
  }
  event.preventDefault();
  options[next]?.focus();
}

watch(unavailable, disabled => {
  if (disabled) {
    close({ restoreFocus: false });
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="llama-model-split-action" tw-class="inline-flex min-w-0 max-w-full rounded-lg border border-gray-200/80 bg-white/70 text-gray-600 transition-[background-color,border-color] duration-200 hover:border-blue-200/80 dark:border-gray-700/70 dark:bg-gray-800/50 dark:text-gray-300 dark:hover:border-blue-500/30 motion-reduce:transition-none">
    <button ref="main" type="button" data-testid="llama-model-action-main" :disabled="unavailable || (mode === 'set_default' && (defaultActionDisabled || selected))" :aria-label="label" :aria-busy="creating" tw-class="group relative flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-l-lg px-2.5 py-1.5 text-xs font-medium transition-colors duration-200 hover:bg-blue-50/60 hover:text-gray-900 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-blue-500/10 dark:hover:text-gray-100 motion-reduce:transition-none" @click="execute">
      <FolderPlusIcon v-if="mode === 'create_chat_group'" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-colors duration-200 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transition-none" /><CheckIcon v-else-if="selected" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><GlobeIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 transition-colors duration-200 group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400 motion-reduce:transition-none" />
      <!-- Every label participates in intrinsic sizing so changing the action
           or its current-default state does not resize the button. -->
      <span data-testid="llama-model-action-labels" tw-class="grid min-w-0 text-left">
        <span data-testid="llama-model-action-label-create-chat-group" :aria-hidden="mode !== 'create_chat_group'" :tw-class="['col-start-1 row-start-1 min-w-0 break-words', { invisible: mode !== 'create_chat_group' }]">{{ lazyStrings.LlamaCppBrowserModelAction__create_chat_group() }}</span>
        <span data-testid="llama-model-action-label-set-default" :aria-hidden="mode !== 'set_default' || selected" :tw-class="['col-start-1 row-start-1 min-w-0 break-words', { invisible: mode !== 'set_default' || selected }]">{{ lazyStrings.llamaCppBrowserDownloads__set_as_default() }}</span>
        <span data-testid="llama-model-action-label-in-use" :aria-hidden="mode !== 'set_default' || !selected" :tw-class="['col-start-1 row-start-1 min-w-0 break-words', { invisible: mode !== 'set_default' || !selected }]">{{ lazyStrings.llamaCppBrowserDownloads__in_use() }}</span>
      </span>
    </button>
    <span aria-hidden="true" tw-class="my-auto h-3.5 w-px shrink-0 bg-gray-200/80 dark:bg-gray-700/70" />
    <button ref="trigger" type="button" data-testid="llama-model-action-options" :disabled="unavailable" :aria-expanded="open" :aria-controls="id" aria-haspopup="menu" :aria-label="lazyStrings.LlamaCppBrowserModelAction__model_actions()" tw-class="relative flex min-h-8 w-7 shrink-0 items-center justify-center rounded-r-lg text-gray-400 transition-colors duration-200 hover:bg-blue-50/60 hover:text-blue-500 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-500 dark:hover:bg-blue-500/10 dark:hover:text-blue-400 motion-reduce:transition-none" @click="open ? close({ restoreFocus: false }) : show({ edge: 'selected' })" @keydown="triggerKey({ event: $event })"><Loader2Icon v-if="creating" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin" /><ChevronDownIcon v-else aria-hidden="true" :tw-class="['h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180']" /></button>
    <MessageActionsMenu :is-open="open" :trigger-el="trigger ?? null" :width="288" @close="close({ restoreFocus: false })">
      <div :id="id" ref="panel" role="menu" :aria-label="lazyStrings.LlamaCppBrowserModelAction__model_actions()" data-testid="llama-model-action-menu" @keydown.stop="menuKey({ event: $event })">
        <button type="button" role="menuitemradio" :aria-checked="mode === 'create_chat_group'" :aria-labelledby="`${id}-create-chat-group-label`" :aria-describedby="`${id}-create-chat-group-description`" :disabled="unavailable" data-testid="llama-model-action-create-chat-group" :tw-class="['flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-xs font-medium hover:bg-blue-50 dark:hover:bg-blue-900/25 focus-visible:outline-none focus-visible:bg-blue-50 dark:focus-visible:bg-blue-900/25 disabled:opacity-40', mode === 'create_chat_group' ? 'bg-blue-50/70 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-200']" @click="choose({ action: 'create_chat_group' })">
          <FolderPlusIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-500 dark:text-blue-400" />
          <span tw-class="min-w-0 flex-1 break-words">
            <span :id="`${id}-create-chat-group-label`" tw-class="block">{{ lazyStrings.LlamaCppBrowserModelAction__create_chat_group() }}</span>
            <span :id="`${id}-create-chat-group-description`" tw-class="mt-1 block text-[10px] font-normal leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelAction__create_a_chat_close_settings_and_open_it() }}</span>
          </span>
          <CheckIcon v-if="mode === 'create_chat_group'" aria-hidden="true" tw-class="mt-0.5 w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
        </button>
        <button type="button" role="menuitemradio" :aria-checked="mode === 'set_default'" :aria-labelledby="`${id}-set-default-label`" :aria-describedby="`${id}-set-default-description`" :disabled="unavailable || defaultActionDisabled" data-testid="llama-model-action-set-default" :tw-class="['flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-xs font-medium hover:bg-blue-50 dark:hover:bg-blue-900/25 focus-visible:outline-none focus-visible:bg-blue-50 dark:focus-visible:bg-blue-900/25 disabled:opacity-40', mode === 'set_default' ? 'bg-blue-50/70 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-200']" @click="choose({ action: 'set_default' })">
          <GlobeIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-500 dark:text-blue-400" />
          <span tw-class="min-w-0 flex-1 break-words">
            <span :id="`${id}-set-default-label`" tw-class="block">{{ lazyStrings.llamaCppBrowserDownloads__set_as_default() }}</span>
            <span :id="`${id}-set-default-description`" tw-class="mt-1 block text-[10px] font-normal leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelAction__set_this_model_as_the_global_default() }}</span>
          </span>
          <CheckIcon v-if="mode === 'set_default'" aria-hidden="true" tw-class="mt-0.5 w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
        </button>
      </div>
    </MessageActionsMenu>
  </div>
</template>
