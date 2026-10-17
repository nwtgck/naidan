<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useElementBounding } from '@vueuse/core';
import {
  XIcon, GitForkIcon,
  ArrowUpIcon, Settings2Icon, DownloadIcon, MoreVerticalIcon, BugIcon, PencilIcon,
  FolderIcon, FolderInputIcon, ChevronRightIcon, HammerIcon, SearchIcon, ImageIcon,
  PrinterIcon, LinkIcon, TerminalIcon, ListIcon, Trash2Icon,
} from 'lucide-vue-next';
import type { MediaShelfVisibility } from '@/composables/useLayout';
import ContextCompactMenuItem from './ContextCompactMenuItem.vue';
import MessageActionsMenu from './MessageActionsMenu.vue';
import SettingsSourceBadge, { type SettingsSourcePresentation } from './SettingsSourceBadge.vue';
import type { ChatPaneHeaderMoreAction } from '@/logic/context-compact';
import { idToRaw } from '@/01-models/ids';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';

type HeaderChat = {
  readonly id: ChatId,
  readonly title: string | null,
  readonly groupId?: ChatGroupId | null,
  readonly originChatId?: ChatId,
  readonly debugEnabled: boolean,
};

type HeaderChatGroup = {
  readonly id: ChatGroupId,
  readonly name: string,
};

const props = defineProps<{
  chat: HeaderChat | null,
  chatGroups: readonly HeaderChatGroup[],
  chatGroupBadge: HeaderChatGroup | undefined,
  activeMessageCount: number,
  modelLabel: string | undefined,
  modelSource?: SettingsSourcePresentation,
  hasOverrides: boolean,
  showChatSettings: boolean,
  outlineVisibility: 'hidden' | 'visible',
  generatingTitle: boolean,
  mediaShelfVisibility: MediaShelfVisibility,
  isChatWeshTerminalOpen: boolean,
}>();

const emit = defineEmits<{
  (e: 'jump-origin'): void,
  (e: 'edit-title'): void,
  (e: 'update:show-chat-settings', value: boolean): void,
  (e: 'fork-last-message'): void,
  (e: 'move-to-group', groupId: ChatGroupId | null): void,
  (e: 'toggle-outline'): void,
  (e: 'print'): void,
  (e: 'search-chat'): void,
  (e: 'open-history'): void,
  (e: 'compact-context'): void,
  (e: 'export-chat'): void,
  (e: 'toggle-media-shelf'): void,
  (e: 'share-url'): void,
  (e: 'open-file-explorer'): void,
  (e: 'toggle-wesh-terminal'): void,
  (e: 'toggle-debug'): void,
  (e: 'open-chat-inspector'): void,
  (e: 'delete-chat'): void,
}>();

const displayedModelName = computed(() => {
  const label = props.modelLabel;
  if (label === undefined) {
    return undefined;
  }
  const lastSlash = label.lastIndexOf('/');
  return lastSlash >= 0 && lastSlash < label.length - 1 ? label.slice(lastSlash + 1) : label;
});

const modelDescription = computed(() => [
  props.modelSource?.label,
  props.modelLabel || lazyStrings.ChatPaneHeader__model_and_chat_settings(),
].filter(value => value !== undefined && value !== '').join(', ') || undefined);

const headerRef = ref<HTMLElement | null>(null);
const { width: headerWidth } = useElementBounding(headerRef);
// Keep the existing controls available until the mounted header has a real width.
const hasMeasuredWidth = computed(() => headerWidth.value > 0);
const wideLayout = computed(() => !hasMeasuredWidth.value || headerWidth.value >= 640);
const showModelRow = computed(() => !hasMeasuredWidth.value || headerWidth.value >= 480);
const showInlineRename = computed(() => !hasMeasuredWidth.value || headerWidth.value >= 640);
const hasMessages = computed(() => props.activeMessageCount > 0);
const showForkButton = computed(() => hasMessages.value && (!hasMeasuredWidth.value || headerWidth.value >= 640));
const showMoveButton = computed(() => !hasMeasuredWidth.value || headerWidth.value >= 480 || (!hasMessages.value && headerWidth.value >= 360));
const showOutlineButton = computed(() => hasMessages.value && (!hasMeasuredWidth.value || headerWidth.value >= 360));

const showMoreMenu = ref(false);
const showMoveMenu = ref(false);
const moreTriggerRef = ref<HTMLElement | null>(null);
const moveTriggerRef = ref<HTMLElement | null>(null);
const renameTriggerRef = ref<HTMLElement | null>(null);
const forkTriggerRef = ref<HTMLElement | null>(null);
const outlineTriggerRef = ref<HTMLElement | null>(null);
const modelTriggerRef = ref<HTMLElement | null>(null);
const moveMenuTrigger = computed(() => showMoveButton.value ? (moveTriggerRef.value ?? moreTriggerRef.value) : moreTriggerRef.value);
const moreTriggerExpanded = computed(() => showMoreMenu.value || (showMoveMenu.value && !showMoveButton.value));
const moreMenuRef = ref<HTMLElement | null>(null);
const moveMenuRef = ref<HTMLElement | null>(null);

function closeFloatingMenus() {
  showMoreMenu.value = false;
  showMoveMenu.value = false;
}

function toggleMoreMenu() {
  const isOpening = !moreTriggerExpanded.value;
  closeFloatingMenus();
  showMoreMenu.value = isOpening;
}

function toggleMoveMenu() {
  const isOpening = !showMoveMenu.value;
  closeFloatingMenus();
  showMoveMenu.value = isOpening;
}

watch(() => props.chat?.id, closeFloatingMenus);

// Pane resizing may not emit a window resize event; keyed menus refresh their anchor bounds.
watch([headerWidth, hasMessages, showInlineRename, showForkButton, showMoveButton, showOutlineButton, showModelRow], async () => {
  const activeElement = document.activeElement;
  const disappearingControl = [
    !showInlineRename.value ? renameTriggerRef.value : undefined,
    !showForkButton.value ? forkTriggerRef.value : undefined,
    !showMoveButton.value ? moveTriggerRef.value : undefined,
    !showOutlineButton.value ? outlineTriggerRef.value : undefined,
    !showModelRow.value ? modelTriggerRef.value : undefined,
  ].some(control => control instanceof HTMLElement && control === activeElement);
  const focusedMenu = moreMenuRef.value?.contains(activeElement) || moveMenuRef.value?.contains(activeElement);
  const returnToMoveTrigger = showMoveMenu.value && showMoveButton.value && !disappearingControl;
  const chatId = props.chat?.id;
  closeFloatingMenus();
  if (!disappearingControl && !focusedMenu) {
    return;
  }
  await nextTick();
  if (props.chat?.id !== chatId || (document.activeElement !== activeElement && document.activeElement !== document.body)) {
    return;
  }
  (returnToMoveTrigger ? moveTriggerRef.value : moreTriggerRef.value)?.focus();
});

function openChatSettingsFromMenu() {
  emit('update:show-chat-settings', true);
  showMoreMenu.value = false;
  moreTriggerRef.value?.focus();
}

function emitOverflowAction({ action }: { action: 'rename' | 'fork' | 'outline' }) {
  switch (action) {
  case 'rename':
    emit('edit-title');
    break;
  case 'fork':
    emit('fork-last-message');
    break;
  case 'outline':
    emit('toggle-outline');
    break;
  default: {
    const _ex: never = action;
    throw new Error(`Unhandled overflow action: ${_ex}`);
  }
  }
  showMoreMenu.value = false;
  moreTriggerRef.value?.focus();
}

async function openMoveMenuFromMore() {
  closeFloatingMenus();
  showMoveMenu.value = true;
  moreTriggerRef.value?.focus();
  await nextTick();
  if (showMoveMenu.value) {
    moveMenuRef.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
}


function handleMenuTab({ event, menuEl, triggerEl, isOpen }: {
  event: KeyboardEvent,
  menuEl: HTMLElement | null,
  triggerEl: HTMLElement | null,
  isOpen: boolean,
}) {
  if (!isOpen || !menuEl || !triggerEl) {
    return;
  }
  const buttons = menuEl.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
  const firstButton = buttons[0];
  const lastButton = buttons[buttons.length - 1];
  // Teleport changes DOM order; retain the tab stops beside the header trigger.
  if (event.currentTarget === triggerEl && !event.shiftKey && firstButton) {
    event.preventDefault();
    firstButton.focus();
  } else if (event.shiftKey && event.target === firstButton) {
    event.preventDefault();
    triggerEl.focus();
  } else if (!event.shiftKey && event.target === lastButton) {
    // Native Tab can now continue from the trigger to the next header/page control.
    triggerEl.focus();
    closeFloatingMenus();
  }
}

function emitMoveToGroup({ groupId }: { groupId: ChatGroupId | null }) {
  emit('move-to-group', groupId);
  showMoveMenu.value = false;
  moveMenuTrigger.value?.focus();
}

function emitDeleteChat() {
  emit('delete-chat');
  showMoreMenu.value = false;
}

function emitMoreAction({ action }: {
  action: ChatPaneHeaderMoreAction,
}) {
  switch (action) {
  case 'print':
    emit('print');
    break;
  case 'search_chat':
    emit('search-chat');
    break;
  case 'open_history':
    emit('open-history');
    break;
  case 'compact_context':
    emit('compact-context');
    break;
  case 'export_chat':
    emit('export-chat');
    break;
  case 'toggle_media_shelf':
    emit('toggle-media-shelf');
    break;
  case 'share_url':
    emit('share-url');
    break;
  case 'open_file_explorer':
    emit('open-file-explorer');
    break;
  case 'toggle_wesh_terminal':
    emit('toggle-wesh-terminal');
    break;
  case 'open_chat_inspector':
    emit('open-chat-inspector');
    break;
  case 'toggle_debug':
    emit('toggle-debug');
    // Keep the menu open so the updated switch state stays visible.
    return;
  default: {
    const _ex: never = action;
    throw new Error(`Unhandled header action: ${_ex}`);
  }
  }
  showMoreMenu.value = false;
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    ref="headerRef"
    :tw-class="['grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 border-b border-gray-200/70 bg-white/80 backdrop-blur-md dark:border-gray-800 dark:bg-gray-900/80 z-20', wideLayout ? 'gap-y-0.5 px-6 py-1.5' : 'px-4 py-1']"
    data-testid="chat-pane-header"
  >
    <div :tw-class="['flex min-w-0 items-center overflow-hidden', wideLayout ? 'min-h-5' : 'min-h-10']">
      <div tw-class="w-full min-w-0 overflow-hidden">
        <template v-if="chat">
          <div tw-class="flex min-w-0 items-center gap-1.5">
            <button
              v-if="chat.originChatId"
              @click="emit('jump-origin')"
              tw-class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
              :title="lazyStrings.ChatPaneHeader__jump_to_original_chat()"
              data-testid="jump-to-origin-button"
            >
              <ArrowUpIcon tw-class="w-4 h-4" />
            </button>
            <h2
              tw-class="relative min-w-0 truncate text-sm font-medium leading-5 text-gray-800 dark:text-gray-100"
              :class="{ 'title-header-generating': generatingTitle }"
              :data-title="chat.title || lazyStrings.SHARED__new_chat()"
              data-testid="chat-header-title"
            >
              <span class="title-header-base">
                {{ chat.title || lazyStrings.SHARED__new_chat() }}
              </span>
              <span
                v-if="generatingTitle"
                class="title-header-scan"
                aria-hidden="true"
              >
                {{ chat.title || lazyStrings.SHARED__new_chat() }}
              </span>
            </h2>
            <span
              v-if="chat.debugEnabled"
              tw-class="flex shrink-0 items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400"
              :title="lazyStrings.ChatPaneHeader__debug_mode()"
              data-testid="chat-debug-enabled"
            >
              <BugIcon tw-class="w-3.5 h-3.5" aria-hidden="true" />
              <span :tw-class="wideLayout ? 'not-sr-only' : 'sr-only'">{{ lazyStrings.ChatPaneHeader__debug_mode() }}</span>
            </span>
            <button
              v-if="showInlineRename"
              ref="renameTriggerRef"
              @click="emit('edit-title')"
              tw-class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40"
              :title="lazyStrings.ChatPaneHeader__edit_chat_title()"
              data-testid="edit-title-button"
            >
              <PencilIcon tw-class="w-3.5 h-3.5" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <div :tw-class="['flex shrink-0 items-center self-center', wideLayout ? 'col-start-2 row-span-2 row-start-1' : 'col-start-2 row-start-1']">
      <div v-if="chat" tw-class="flex shrink-0 items-center">
        <button
          v-if="showForkButton"
          ref="forkTriggerRef"
          @click="emit('fork-last-message')"
          tw-class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40"
          :title="lazyStrings.ChatPaneHeader__fork_chat_from_last_message()"
          data-testid="fork-chat-button"
        >
          <GitForkIcon tw-class="w-4.5 h-4.5" />
        </button>

        <div tw-class="relative">
          <button
            v-if="showMoveButton"
            ref="moveTriggerRef"
            @click="toggleMoveMenu"
            @keydown.tab="handleMenuTab({ event: $event, menuEl: moveMenuRef, triggerEl: moveMenuTrigger, isOpen: showMoveMenu })"
            :tw-class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', showMoveMenu ? 'text-blue-600 dark:text-blue-400 bg-blue-400/10' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']"
            :title="lazyStrings.ChatPaneHeader__move_to_group()"
            :aria-expanded="showMoveMenu"
            data-testid="move-to-group-button"
          >
            <FolderInputIcon tw-class="w-4.5 h-4.5" />
          </button>

          <MessageActionsMenu
            :key="headerWidth"
            :is-open="showMoveMenu"
            :trigger-el="moveMenuTrigger"
            :width="256"
            @close="showMoveMenu = false"
          >
            <div
              ref="moveMenuRef"
              tw-class="py-0.5"
              data-testid="chat-header-move-menu"
              @keydown.tab="handleMenuTab({ event: $event, menuEl: moveMenuRef, triggerEl: moveMenuTrigger, isOpen: showMoveMenu })"
            >
              <div tw-class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
                {{ lazyStrings.ChatPaneHeader__move_to_group() }}
              </div>
              <div>
                <button
                  @click="emitMoveToGroup({ groupId: null })"
                  data-testid="move-to-top-level-button"
                  :tw-class="['w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors', !chat.groupId ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700']"
                >
                  <div tw-class="flex items-center gap-2">
                    <XIcon tw-class="w-4 h-4 opacity-50" />
                    <span>{{ lazyStrings.ChatPaneHeader__top_level() }}</span>
                  </div>
                  <ChevronRightIcon v-if="!chat.groupId" tw-class="w-4 h-4" />
                </button>

                <button
                  v-for="group in chatGroups"
                  :key="idToRaw({ id: group.id })"
                  @click="emitMoveToGroup({ groupId: group.id })"
                  data-testid="move-to-group-option"
                  :tw-class="['w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors', chat.groupId === group.id ? 'text-blue-600 bg-blue-50/50 dark:bg-blue-900/20 font-bold' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700']"
                >
                  <div tw-class="flex items-center gap-2 overflow-hidden">
                    <FolderIcon tw-class="w-4 h-4 opacity-50 shrink-0" />
                    <span tw-class="truncate">{{ group.name }}</span>
                  </div>
                  <ChevronRightIcon v-if="chat.groupId === group.id" tw-class="w-4 h-4" />
                </button>
              </div>
            </div>
          </MessageActionsMenu>
        </div>

        <button
          v-if="showOutlineButton"
          ref="outlineTriggerRef"
          @click="emit('toggle-outline')"
          :tw-class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', outlineVisibility === 'visible' ? 'text-blue-600 dark:text-blue-400 bg-blue-400/10' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']"
          :title="lazyStrings.ChatPaneHeader__conversation_outline()"
          :aria-pressed="outlineVisibility === 'visible'"
          data-testid="conversation-outline-button"
        >
          <ListIcon tw-class="w-4.5 h-4.5" />
        </button>

        <button
          ref="moreTriggerRef"
          @click="toggleMoreMenu"
          @keydown.tab="handleMenuTab({ event: $event, menuEl: showMoveMenu && !showMoveButton ? moveMenuRef : moreMenuRef, triggerEl: moreTriggerRef, isOpen: moreTriggerExpanded })"
          :tw-class="['flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', moreTriggerExpanded ? 'text-blue-600 dark:text-blue-400 bg-blue-400/10' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400']"
          :title="lazyStrings.ChatPaneHeader__more_actions()"
          :aria-expanded="moreTriggerExpanded"
          data-testid="more-actions-button"
        >
          <MoreVerticalIcon tw-class="w-4.5 h-4.5" />
        </button>
      </div>

      <MessageActionsMenu
        v-if="chat"
        :key="headerWidth"
        :is-open="showMoreMenu"
        :trigger-el="moreTriggerRef"
        :width="272"
        @close="showMoreMenu = false"
      >
        <div
          ref="moreMenuRef"
          tw-class="px-1 py-0.5"
          data-testid="chat-header-more-menu"
          @keydown.tab="handleMenuTab({ event: $event, menuEl: moreMenuRef, triggerEl: moreTriggerRef, isOpen: showMoreMenu })"
        >
          <button @click="openChatSettingsFromMenu" tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400" data-testid="open-chat-settings-button">
            <Settings2Icon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__chat_settings() }}</span>
          </button>
          <button v-if="!showInlineRename" @click="emitOverflowAction({ action: 'rename' })" tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400" data-testid="overflow-edit-title-button">
            <PencilIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__edit_chat_title() }}</span>
          </button>
          <button v-if="hasMessages && !showForkButton" @click="emitOverflowAction({ action: 'fork' })" tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400" data-testid="overflow-fork-chat-button">
            <GitForkIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__fork_chat_from_last_message() }}</span>
          </button>
          <button v-if="!showMoveButton" @click="openMoveMenuFromMore" tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400" data-testid="overflow-move-to-group-button">
            <FolderInputIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__move_to_group() }}</span>
          </button>
          <button
            v-if="hasMessages && !showOutlineButton"
            @click="emitOverflowAction({ action: 'outline' })"
            :tw-class="['group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', outlineVisibility === 'visible' ? 'bg-blue-400/10 text-blue-600 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400']"
            :aria-pressed="outlineVisibility === 'visible'"
            data-testid="overflow-conversation-outline-button"
          >
            <ListIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__conversation_outline() }}</span>
          </button>
          <div tw-class="mx-3 my-1 h-px bg-gray-200/80 dark:bg-gray-700/60" role="separator" aria-orientation="horizontal" />
          <button
            @click="emitMoreAction({ action: 'search_chat' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            data-testid="search-in-chat-button"
          >
            <SearchIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__search_in_chat() }}</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'toggle_media_shelf' })"
            :tw-class="['group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', mediaShelfVisibility === 'visible' ? 'bg-blue-400/10 text-blue-600 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400']"
            :aria-pressed="mediaShelfVisibility === 'visible'"
            data-testid="toggle-media-gallery-button"
          >
            <ImageIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__media_gallery() }}</span>
          </button>
          <div tw-class="mx-3 my-1 h-px bg-gray-200/80 dark:bg-gray-700/60" role="separator" aria-orientation="horizontal" />
          <button
            @click="emitMoreAction({ action: 'open_history' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            :title="lazyStrings.ChatPaneHeader__super_edit_full_history()"
            data-testid="super-edit-button"
          >
            <HammerIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__super_edit() }}</span>
          </button>
          <ContextCompactMenuItem @compact="emitMoreAction({ action: 'compact_context' })" />
          <div tw-class="mx-3 my-1 h-px bg-gray-200/80 dark:bg-gray-700/60" role="separator" aria-orientation="horizontal" />
          <button
            @click="emitMoreAction({ action: 'print' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            :title="lazyStrings.ChatPaneHeader__open_print_dialog()"
            data-testid="print-chat-button"
          >
            <PrinterIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__print() }}</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'export_chat' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            :title="lazyStrings.ChatPaneHeader__export_as_markdown()"
            data-testid="export-markdown-button"
          >
            <DownloadIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__export_markdown() }}</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'share_url' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            :title="lazyStrings.ChatPaneHeader__copy_shareable_chat_url()"
            data-testid="export-url-button"
          >
            <LinkIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__export_as_url() }}</span>
          </button>
          <div tw-class="mx-3 my-1 h-px bg-gray-200/80 dark:bg-gray-700/60" role="separator" aria-orientation="horizontal" />
          <button
            @click="emitMoreAction({ action: 'open_file_explorer' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            data-testid="open-chat-file-explorer-button"
          >
            <FolderIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__file_explorer() }}</span>
          </button>
          <button
            @click="emitMoreAction({ action: 'toggle_wesh_terminal' })"
            :tw-class="['group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', isChatWeshTerminalOpen ? 'bg-blue-400/10 text-blue-600 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400']"
            :aria-pressed="isChatWeshTerminalOpen"
            data-testid="open-chat-wesh-terminal-button"
          >
            <TerminalIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__wesh_terminal() }}</span>
          </button>
          <div tw-class="mx-3 my-1 h-px bg-gray-200/80 dark:bg-gray-700/60" role="separator" aria-orientation="horizontal" />
          <button
            @click="emitMoreAction({ action: 'toggle_debug' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            role="switch"
            :aria-checked="chat?.debugEnabled === true"
            data-testid="toggle-debug-button"
          >
            <BugIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__debug_mode() }}</span>
            <span
              aria-hidden="true"
              :tw-class="['relative ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', chat?.debugEnabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600']"
            >
              <span
                :tw-class="['block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none', chat?.debugEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]']"
                data-testid="debug-toggle-thumb"
              />
            </span>
          </button>
          <button
            @click="emitMoreAction({ action: 'open_chat_inspector' })"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-blue-400/10 dark:hover:text-blue-400"
            data-testid="open-chat-inspector-button"
          >
            <SearchIcon tw-class="h-4 w-4 shrink-0 text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__chat_inspector() }}</span>
          </button>
          <div tw-class="mx-3 my-1 h-px bg-gray-200/80 dark:bg-gray-700/60" role="separator" aria-orientation="horizontal" />
          <button
            @click="emitDeleteChat()"
            tw-class="group flex min-h-9 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-400/10"
            data-testid="delete-chat-button"
          >
            <Trash2Icon tw-class="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{{ lazyStrings.ChatPaneHeader__delete_chat() }}</span>
          </button>
        </div>
      </MessageActionsMenu>
    </div>
    <div v-if="chat && showModelRow" :tw-class="['flex h-5 min-w-0 items-center gap-2 text-[11px] leading-4', wideLayout ? 'col-span-1 col-start-1 row-start-2' : 'col-span-2']" data-testid="chat-header-model-row">
      <div
        v-if="chatGroupBadge"
        :tw-class="['flex min-w-0 shrink items-center gap-1 text-gray-500 dark:text-gray-400', wideLayout ? 'max-w-[180px]' : 'max-w-12']"
        :title="lazyStrings.ChatPaneHeader__group_name({ groupName: chatGroupBadge.name })"
        data-testid="chat-group-badge"
      >
        <FolderIcon tw-class="h-3 w-3 shrink-0" aria-hidden="true" />
        <span tw-class="truncate">{{ chatGroupBadge.name }}</span>
      </div>
      <span v-if="chatGroupBadge" tw-class="h-3 w-px shrink-0 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
      <button
        ref="modelTriggerRef"
        @click="emit('update:show-chat-settings', !showChatSettings)"
        :tw-class="['group flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/40', wideLayout ? 'max-w-lg flex-initial' : 'max-w-full flex-1', showChatSettings
          ? 'bg-blue-400/10 text-blue-600 dark:text-blue-400'
          : 'text-gray-500 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-blue-400']"
        :title="lazyStrings.ChatPaneHeader__chat_settings_and_model_override()"
        :aria-label="lazyStrings.ChatPaneHeader__model_and_chat_settings()"
        :aria-description="modelDescription"
        :aria-expanded="showChatSettings"
        data-testid="model-trigger"
      >
        <span v-if="modelSource" class="header-model-source" tw-class="min-w-0 max-w-[38%] shrink-0 overflow-hidden" data-testid="chat-model-source"><SettingsSourceBadge :source="modelSource" /></span>
        <span data-testid="chat-model-name" :title="modelLabel" tw-class="min-w-0 truncate whitespace-nowrap">
          {{ displayedModelName || lazyStrings.ChatPaneHeader__model_and_chat_settings() }}
        </span>
        <Settings2Icon tw-class="h-3 w-3 shrink-0" aria-hidden="true" />
        <span
          v-if="hasOverrides"
          tw-class="h-1 w-1 shrink-0 rounded-full bg-blue-500 dark:bg-blue-400"
          :title="lazyStrings.ChatPaneHeader__custom_overrides_active()"
          data-testid="custom-overrides-indicator"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.header-model-source :deep(> span) {
  max-width: 100%;
}

.title-header-generating {
  text-shadow: none;
}

.title-header-base {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title-header-scan {
  position: absolute;
  inset: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: transparent;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 43%,
    rgba(59, 130, 246, 0.9) 48%,
    rgb(255 255 255) 50%,
    rgba(59, 130, 246, 0.9) 52%,
    transparent 57%,
    transparent 100%
  );
  background-size: 260% 100%;
  background-position: 130% 0;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  pointer-events: none;
  animation: title-header-scan 2.35s linear infinite;
}

:global(.dark) .title-header-scan {
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    transparent 43%,
    rgba(96, 165, 250, 0.85) 48%,
    rgb(255 255 255) 50%,
    rgba(96, 165, 250, 0.85) 52%,
    transparent 57%,
    transparent 100%
  );
}

@keyframes title-header-scan {
  0% {
    background-position: 130% 0;
  }
  100% {
    background-position: -130% 0;
  }
}
</style>
