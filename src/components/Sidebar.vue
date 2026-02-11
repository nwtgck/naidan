<script setup lang="ts">
import { onMounted, ref, watch, nextTick, computed, toRaw, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import draggable from 'vuedraggable';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
// IMPORTANT: Logo is part of the initial sidebar layout and should not flicker.
import Logo from './Logo.vue';
// IMPORTANT: ModelSelector is part of the initial sidebar layout and should not flicker.
import ModelSelector from './ModelSelector.vue';
import SidebarDebugControls from './SidebarDebugControls.vue';
import type { ChatGroup, SidebarItem } from '../models/types';
import { 
  Trash2, Settings as SettingsIcon, 
  Pencil, Folder, FolderPlus, 
  ChevronDown, ChevronUp, ChevronRight, Check, X,
  Bot, PanelLeft, SquarePen, Loader2, MoreHorizontal,
} from 'lucide-vue-next';

const ChatGroupActions = defineAsyncComponentAndLoadOnMounted(() => import('./ChatGroupActions.vue'));
import { useLayout } from '../composables/useLayout';
import { useConfirm } from '../composables/useConfirm';
import { naturalSort } from '../utils/string';

const chatStore = useChat();
const { 
  currentChat, currentChatGroup, chatGroups, chats, isProcessing,
} = chatStore;

const { settings, isFetchingModels, availableModels, updateGlobalModel } = useSettings();
const sortedModels = computed(() => naturalSort(availableModels.value || []));
const { isSidebarOpen, activeFocusArea, setActiveFocusArea, toggleSidebar } = useLayout();
const { showConfirm } = useConfirm();

const router = useRouter();
const route = useRoute();

defineEmits<{
  (e: 'open-settings'): void
}>();

const sidebarItemsLocal = ref<SidebarItem[]>([]);
const isDragging = ref(false);
const dragHoverGroup = ref<string | null>(null);
let dragHoverTimeout: ReturnType<typeof setTimeout> | null = null;
let isInternalUpdate = false;

const editingId = ref<string | null>(null);
const editingTitle = ref('');
const isCreatingChatGroup = ref(false);
const newChatGroupName = ref('');
const editingChatGroupId = ref<string | null>(null);
const editingChatGroupName = ref('');
const skipLeaveAnimation = ref(false);
const lastNavigatedId = ref<string | null>(null);

const activeActionGroupId = ref<string | null>(null);

const COMPACT_THRESHOLD = 5;
const expandedGroupIds = ref<Set<string>>(new Set());
const collapsingGroupIds = ref<Set<string>>(new Set());

function isGroupCompactExpanded(groupId: string) {
  return expandedGroupIds.value.has(groupId);
}

function toggleGroupCompactExpansion(groupId: string) {
  if (expandedGroupIds.value.has(groupId)) {
    collapsingGroupIds.value.add(groupId);
    expandedGroupIds.value.delete(groupId);
    // Wait for the transition to finish (400ms) before removing items from DOM
    setTimeout(() => {
      collapsingGroupIds.value.delete(groupId);
    }, 400);
  } else {
    expandedGroupIds.value.add(groupId);
  }
}

// Custom directive for auto-focusing elements
const vFocus = {
  mounted: (el: HTMLElement) => el.focus(),
};

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const newChatShortcutText = isMac ? '⌘⇧O' : 'Ctrl+Shift+O';
const appVersion = __APP_VERSION__;

function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (activeActionGroupId.value && !target.closest('.group-action-container')) {
    activeActionGroupId.value = null;
  }
}

onMounted(() => {
  syncLocalItems();
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});

function syncLocalItems() {
  if (isDragging.value || isInternalUpdate) return;
  // Use JSON.parse/stringify for robust deep cloning of reactive objects in test environments
  sidebarItemsLocal.value = JSON.parse(JSON.stringify(chatStore.sidebarItems.value));
}

// Watch for external changes (new chats, deletions) to sync local list
watch([chatGroups, chats], () => {
  syncLocalItems();
}, { deep: true });

// --- DND Handlers ---

function onDragStart() {
  isDragging.value = true;
}

async function onDragEnd() {
  isInternalUpdate = true;
  dragHoverGroup.value = null;
  if (dragHoverTimeout) {
    clearTimeout(dragHoverTimeout);
    dragHoverTimeout = null;
  }
  // Sync the UI structure to storage
  await chatStore.persistSidebarStructure(sidebarItemsLocal.value);
  
  // Wait for DOM and Sortable cleanup
  await nextTick();
  isDragging.value = false;
  setTimeout(() => {
    isInternalUpdate = false;
  }, 100);
}

function onDragOverGroup(groupId: string) {
  if (!isDragging.value) return;
  if (dragHoverGroup.value === groupId) return;
  
  dragHoverGroup.value = groupId;
  if (dragHoverTimeout) clearTimeout(dragHoverTimeout);
  
  dragHoverTimeout = setTimeout(() => {
    const group = chatStore.chatGroups.value.find(g => g.id === groupId);
    if (group && group.isCollapsed) {
      chatStore.setChatGroupCollapsed({ groupId, isCollapsed: false });
    }
  }, 600); // 600ms hover to expand
}

function onDragLeaveGroup() {
  dragHoverGroup.value = null;
  if (dragHoverTimeout) {
    clearTimeout(dragHoverTimeout);
    dragHoverTimeout = null;
  }
}

/**
 * Move callback to prevent invalid nesting.
 * Only chats can be moved into chat groups. Chat groups cannot be nested.
 */
function checkMove(evt: { draggedContext: { element: SidebarItem }; to: HTMLElement }) {
  const draggedItem = evt.draggedContext.element;
  // If dragging into a nested list (a chat group's items)
  if (evt.to.classList.contains('nested-draggable')) {
    // Only allow chats
    switch (draggedItem.type) {
    case 'chat':
      return true;
    case 'chat_group':
      return false;
    default: {
      const _ex: never = draggedItem;
      return _ex;
    }
    }
  }
  return true;
}

// --- Actions ---

async function handleCreateChatGroup() {
  const name = newChatGroupName.value.trim();
  if (!name) {
    isCreatingChatGroup.value = false;
    return;
  }
  skipLeaveAnimation.value = true;
  await chatStore.createChatGroup(name);
  newChatGroupName.value = '';
  isCreatingChatGroup.value = false;
  // Reset flag after transition would have finished
  setTimeout(() => {
    skipLeaveAnimation.value = false; 
  }, 200);
}

function handleCreateChatGroupBlur() {
  if (!newChatGroupName.value.trim()) {
    skipLeaveAnimation.value = false;
    isCreatingChatGroup.value = false;
  }
}

function cancelCreateChatGroup() {
  skipLeaveAnimation.value = false;
  isCreatingChatGroup.value = false;
  newChatGroupName.value = '';
}

async function handleDeleteChatGroup(group: ChatGroup) {
  const hasItems = group.items && group.items.length > 0;
  const hasCustomSettings = !!(group.systemPrompt || group.modelId || group.endpoint || group.lmParameters);

  if (hasItems || hasCustomSettings) {
    const confirmed = await showConfirm({
      title: 'Delete Group?',
      message: `Are you sure you want to delete "${group.name}"? This will permanently delete all ${group.items.length} chats inside it.`,
      confirmButtonText: 'Delete Group',
      cancelButtonText: 'Cancel',
      confirmButtonVariant: 'danger',
    });
    if (!confirmed) return;
  }
  
  await chatStore.deleteChatGroup(group.id);
}

async function handleNewChat(groupId: string | undefined = undefined) {
  setActiveFocusArea('chat');
  await chatStore.createNewChat({ 
    groupId, 
    modelId: undefined, 
    systemPrompt: undefined 
  });
  if (currentChat.value) {
    router.push(`/chat/${currentChat.value.id}`);
  }
}

async function handleOpenChat(id: string) {
  await chatStore.openChat(id);
  router.push(`/chat/${id}`);
}

async function handleOpenChatGroup(id: string) {
  chatStore.openChatGroup(id);
  router.push(`/chat-group/${id}`);
}

// Clear lastNavigatedId when store catches up to prevent stale index calculations
watch([() => currentChat.value?.id, () => currentChatGroup.value?.id], ([chatId, groupId]) => {
  if (chatId === lastNavigatedId.value || groupId === lastNavigatedId.value) {
    lastNavigatedId.value = null;
  }
});

async function handleDeleteChat(id: string) {
  const isCurrent = currentChat.value?.id === id;
  await chatStore.deleteChat(id);
  if (isCurrent) router.push('/');
}

function startEditing(id: string, title: string | null) {
  editingId.value = id;
  editingTitle.value = title || '';
}

async function saveRename() {
  if (editingId.value && editingTitle.value.trim()) {
    await chatStore.renameChat(editingId.value, editingTitle.value.trim());
  }
  editingId.value = null;
}

function startEditingChatGroup(chatGroup: ChatGroup) {
  editingChatGroupId.value = chatGroup.id;
  editingChatGroupName.value = chatGroup.name;
}

async function saveChatGroupRename() {
  if (editingChatGroupId.value && editingChatGroupName.value.trim()) {
    await chatStore.renameChatGroup(editingChatGroupId.value, editingChatGroupName.value.trim());
  }
  editingChatGroupId.value = null;
}

async function handleGlobalModelChange(newModelId: string | undefined) {
  if (!newModelId) return;
  await updateGlobalModel(newModelId);
}

function getGroupItems(groupId: string) {
  const group = sidebarItemsLocal.value.find(item => item.type === 'chat_group' && item.chatGroup.id === groupId);
  if (!group || group.type !== 'chat_group') return [];
  
  const items = group.chatGroup.items;
  if (isGroupCompactExpanded(groupId) || collapsingGroupIds.value.has(groupId) || items.length <= COMPACT_THRESHOLD) {
    return items;
  }
  return items.slice(0, COMPACT_THRESHOLD);
}

function updateGroupItems(groupId: string, newItems: SidebarItem[]) {
  const groupIndex = sidebarItemsLocal.value.findIndex(item => item.type === 'chat_group' && item.chatGroup.id === groupId);
  if (groupIndex === -1) return;
  
  const group = sidebarItemsLocal.value[groupIndex];
  if (!group || group.type !== 'chat_group') return;

  const fullList = group.chatGroup.items;
  if (isGroupCompactExpanded(groupId) || collapsingGroupIds.value.has(groupId) || fullList.length <= COMPACT_THRESHOLD) {
    group.chatGroup.items = newItems;
  } else {
    const hiddenItems = fullList.slice(COMPACT_THRESHOLD);
    group.chatGroup.items = [...newItems, ...hiddenItems];
  }
}

function useGroupItemsModel(groupId: string) {
  return computed({
    get: () => getGroupItems(groupId),
    set: (val) => updateGroupItems(groupId, val)
  });
}

function handleToggleChatGroupCollapse(chatGroup: ChatGroup) {
  // Toggle locally for instant, flicker-free feedback
  chatGroup.isCollapsed = !chatGroup.isCollapsed;
  
  // Reset compact expansion state if collapsed
  if (chatGroup.isCollapsed) {
    expandedGroupIds.value.delete(chatGroup.id);
  }

  // Persist to store
  chatStore.setChatGroupCollapsed({ 
    groupId: chatGroup.id, 
    isCollapsed: chatGroup.isCollapsed 
  });
}

// Scroll active chat into view
watch(() => currentChat.value?.id, async (id) => {
  if (!id || typeof document === 'undefined') return;
  await nextTick();
  // Wait a bit for potential transitions
  setTimeout(() => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector(`[data-testid="sidebar-chat-item-${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 100);
}, { immediate: true });

// Scroll active group into view
watch(() => currentChatGroup.value?.id, async (id) => {
  if (!id || typeof document === 'undefined') return;
  await nextTick();
  setTimeout(() => {
    if (typeof document === 'undefined') return;
    const el = document.querySelector(`[data-sidebar-group-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 100);
}, { immediate: true });

const visibleItems = computed(() => {
  const result: { type: 'chat' | 'chat_group' | 'expand_button'; id: string; groupId?: string }[] = [];
  function collect(list: SidebarItem[]) {
    for (const item of list) {
      switch (item.type) {
      case 'chat':
        result.push({ type: 'chat', id: item.chat.id });
        break;
      case 'chat_group':
        result.push({ type: 'chat_group', id: item.chatGroup.id });
        if (!item.chatGroup.isCollapsed) {
          const items = item.chatGroup.items;
          const isExpanded = isGroupCompactExpanded(item.chatGroup.id);
          const shownItems = (isExpanded || items.length <= COMPACT_THRESHOLD) 
            ? items 
            : items.slice(0, COMPACT_THRESHOLD);
            
          collect(shownItems);

          if (items.length > COMPACT_THRESHOLD) {
            result.push({ 
              type: 'expand_button', 
              id: `expand-${item.chatGroup.id}`, 
              groupId: item.chatGroup.id 
            });
          }
        }
        break;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    }
  }
  collect(sidebarItemsLocal.value);
  return result;
});

const focusedId = computed(() => {
  if (lastNavigatedId.value && visibleItems.value.some(i => i.id === lastNavigatedId.value)) {
    return lastNavigatedId.value;
  }
  return currentChatGroup.value?.id || currentChat.value?.id || null;
});

onKeyStroke(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], (e) => {
  const area = activeFocusArea.value;
  switch (area) {
  case 'sidebar':
    break;
  case 'chat':
  case 'chat-group-settings':
  case 'chat-settings':
  case 'settings':
  case 'onboarding':
  case 'dialog':
  case 'none':
    return;
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled focus area: ${_ex}`);
  }
  }

  if (
    editingId.value || 
    editingChatGroupId.value || 
    isCreatingChatGroup.value
  ) {
    return;
  }

  if (visibleItems.value.length === 0) return;

  // Prioritize the ID we just navigated to, then group, then chat.
  // This prevents jumping back if the store hasn't updated currentChat yet.
  const currentId = focusedId.value;
    
  let currentIndex = currentId ? visibleItems.value.findIndex(i => i.id === currentId) : -1;

  // Fallback: If current item is hidden (e.g. inside collapsed group), 
  // try using its parent group's index as starting point.
  if (currentIndex === -1 && currentChat.value?.groupId) {
    currentIndex = visibleItems.value.findIndex(i => i.id === currentChat.value?.groupId);
  }

  if (e.key === 'ArrowDown') {
    const nextIndex = currentIndex + 1;
    if (nextIndex < visibleItems.value.length) {
      e.preventDefault();
      const item = visibleItems.value[nextIndex];
      if (item) {
        lastNavigatedId.value = item.id;
        const type = item.type;
        switch (type) {
        case 'chat':
          handleOpenChat(item.id);
          break;
        case 'chat_group':
          handleOpenChatGroup(item.id);
          break;
        case 'expand_button':
          break;
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled item type: ${_ex}`);
        }
        }
      }
    }
  } else if (e.key === 'ArrowUp') {
    const nextIndex = currentIndex - 1;
    if (nextIndex >= 0) {
      e.preventDefault();
      const item = visibleItems.value[nextIndex];
      if (item) {
        lastNavigatedId.value = item.id;
        const type = item.type;
        switch (type) {
        case 'chat':
          handleOpenChat(item.id);
          break;
        case 'chat_group':
          handleOpenChatGroup(item.id);
          break;
        case 'expand_button':
          break;
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled item type: ${_ex}`);
        }
        }
      }
    }
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const currentItem = currentIndex !== -1 ? visibleItems.value[currentIndex] : null;
    
    if (currentItem?.type === 'expand_button' && currentItem.groupId) {
      if (e.key === 'ArrowRight' && !isGroupCompactExpanded(currentItem.groupId)) {
        e.preventDefault();
        toggleGroupCompactExpansion(currentItem.groupId);
        // After expansion, select the first newly revealed item (the 6th item, which is at currentIndex)
        // Wait for next tick so visibleItems updates
        nextTick(() => {
          const itemAfterExpansion = visibleItems.value[currentIndex];
          if (itemAfterExpansion && itemAfterExpansion.type === 'chat') {
            lastNavigatedId.value = itemAfterExpansion.id;
            handleOpenChat(itemAfterExpansion.id);
          }
        });
      } else if (e.key === 'ArrowLeft' && isGroupCompactExpanded(currentItem.groupId)) {
        e.preventDefault();
        toggleGroupCompactExpansion(currentItem.groupId);
      }
      return;
    }

    const groupId = currentChatGroup.value?.id;
    if (groupId) {
      const group = chatStore.chatGroups.value.find(g => g.id === groupId);
      if (group) {
        if (e.key === 'ArrowRight' && group.isCollapsed) {
          e.preventDefault();
          handleToggleChatGroupCollapse(group);
        } else if (e.key === 'ArrowLeft' && !group.isCollapsed) {
          e.preventDefault();
          handleToggleChatGroupCollapse(group);
        }
      }
    // eslint-disable-next-line local-rules-switch/force-switch-for-union
    } else if (e.key === 'ArrowLeft') {
      // Use toRaw to ensure we access the underlying data properties reliably
      const rawChat = toRaw(currentChat.value);
      if (rawChat?.groupId) {
        e.preventDefault();
        lastNavigatedId.value = rawChat.groupId;
        handleOpenChatGroup(rawChat.groupId);
      }
    }
  }
});</script>

<template>
  <div class="flex flex-col h-full bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 select-none transition-colors">
    <!-- Header -->
    <div class="py-4 flex items-center overflow-hidden" :class="isSidebarOpen ? 'justify-between px-4' : 'justify-center px-1'">
      <router-link v-if="isSidebarOpen" to="/" class="flex items-center gap-3 hover:opacity-80 transition-opacity cursor-pointer overflow-hidden">
        <div class="p-1.5 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 shrink-0">
          <Logo :size="20" />
        </div>
        <div class="flex items-baseline gap-1.5 animate-in fade-in duration-300">
          <h1 class="text-lg font-bold tracking-tight bg-gradient-to-br from-gray-800 to-gray-500 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">
            Naidan
          </h1>
          <span class="text-[10px] font-medium text-gray-400 dark:text-gray-500">v{{ appVersion }}</span>
        </div>
      </router-link>
      <button 
        @click="toggleSidebar"
        class="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors shrink-0"
        :title="isSidebarOpen ? 'Close Sidebar' : 'Open Sidebar'"
        data-testid="sidebar-toggle"
      >
        <PanelLeft class="w-5 h-5" />
      </button>
    </div>

    <!-- Actions -->
    <div class="py-4 space-y-2" :class="isSidebarOpen ? 'px-4' : 'px-1'">
      <div class="flex gap-2" :class="{ 'flex-col items-center': !isSidebarOpen }">
        <button 
          @click="handleNewChat(undefined)"
          class="flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all font-bold shadow-lg shadow-blue-500/20 disabled:opacity-50"
          :class="isSidebarOpen ? 'flex-1 px-3 py-3 text-xs' : 'w-8 h-8'"
          data-testid="new-chat-button"
          :title="!isSidebarOpen ? 'New Chat' : ''"
        >
          <SquarePen class="w-4 h-4 shrink-0" />
          <template v-if="isSidebarOpen">
            <span class="whitespace-nowrap overflow-hidden">New Chat</span>
            <span class="text-[9px] opacity-60 font-normal shrink-0 hidden lg:inline">{{ newChatShortcutText }}</span>
          </template>
        </button>
        <button 
          v-if="isSidebarOpen"
          @click="isCreatingChatGroup = true"
          class="p-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-xl border border-gray-100 dark:border-gray-700 transition-colors shadow-sm"
          title="Create Chat Group"
          data-testid="create-chat-group-button"
        >
          <FolderPlus class="w-4 h-4" />
        </button>
      </div>
    </div>
    <!-- Navigation List -->
    <div 
      class="flex-1 overflow-y-auto px-3 py-2 scrollbar-hide focus:outline-none overscroll-contain" 
      :class="{ 'is-dragging': isDragging }"
      data-testid="sidebar-nav"
      tabindex="0"
      @focus="setActiveFocusArea('sidebar')"
      @click="setActiveFocusArea('sidebar')"
    >
      <template v-if="isSidebarOpen">
        <Transition name="chat-group-new">
          <div v-if="isCreatingChatGroup" :class="{ 'skip-leave': skipLeaveAnimation }" class="flex items-center justify-between p-2 rounded-xl bg-blue-50/30 dark:bg-blue-900/10 border border-blue-200/50 dark:border-blue-500/20 mb-1" data-testid="chat-group-creation-container">
            <div class="flex items-center gap-2 overflow-hidden flex-1">
              <Folder class="w-4 h-4 text-blue-500/60 shrink-0" />
              <input 
                v-focus
                v-model="newChatGroupName"
                @keydown.enter="$event => !$event.isComposing && handleCreateChatGroup()"
                @keyup.esc="cancelCreateChatGroup"
                @blur="handleCreateChatGroupBlur"
                class="bg-transparent text-sm text-gray-800 dark:text-white outline-none w-full px-1 font-bold tracking-tight placeholder:font-normal placeholder:text-gray-400 dark:placeholder:text-gray-500"
                placeholder="Group name..."
                data-testid="chat-group-name-input"
              />
            </div>
            <div class="flex items-center gap-0.5 shrink-0 ml-1">
              <button @click="handleCreateChatGroup" class="p-1 text-gray-400 hover:text-green-600 dark:text-gray-400 dark:hover:text-white transition-colors" data-testid="confirm-create-chat-group">
                <Check class="w-4 h-4" />
              </button>
              <button @click="cancelCreateChatGroup" class="p-1 text-gray-400 hover:text-red-500 dark:text-gray-400 dark:hover:text-white transition-colors">
                <X class="w-4 h-4" />
              </button>
            </div>
          </div>
        </Transition>

        <draggable 
          v-model="sidebarItemsLocal" 
          item-key="id"
          handle=".handle"
          tag="div"
          :group="{ name: 'sidebar' }"
          :move="checkMove"
          :animation="0"
          :delay="200"
          :delay-on-touch-only="true"
          @start="onDragStart"
          @end="onDragEnd"
          ghost-class="sortable-ghost"
          :class="['space-y-1 min-h-[100px]', isDragging ? 'pb-32' : 'pb-4']"
          :swap-threshold="0.5"
          :invert-swap="true"
          :scroll="true"
          :scroll-sensitivity="100"
          :scroll-speed="20"
          :force-fallback="true"
          fallback-class="opacity-0"
        >
          <template #item="{ element }">
            <div :class="{ 'is-group': element.type === 'chat_group' }">
              <!-- Chat Group Item -->
              <div v-if="element.type === 'chat_group'" class="space-y-1">
                <div 
                  @click="handleOpenChatGroup(element.chatGroup.id)"
                  @dragover="onDragOverGroup(element.chatGroup.id)"
                  @dragleave="onDragLeaveGroup"
                  class="flex items-center justify-between p-2 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer text-gray-500 dark:text-gray-400 group/folder relative handle"
                  :class="{ 
                    'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm': focusedId === element.chatGroup.id,
                    'ring-2 ring-blue-500/50 bg-blue-50/50 dark:bg-blue-900/30': dragHoverGroup === element.chatGroup.id
                  }"
                  data-testid="chat-group-item"
                  :data-sidebar-group-id="element.chatGroup.id"
                >
                  <div class="flex items-center gap-2 overflow-hidden flex-1 pointer-events-none">
                    <button 
                      @click.stop="handleToggleChatGroupCollapse(element.chatGroup)"
                      class="p-1 -ml-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg pointer-events-auto transition-colors"
                    >
                      <component :is="element.chatGroup.isCollapsed ? ChevronRight : ChevronDown" class="w-3 h-3 flex-shrink-0" />
                    </button>
                    <Folder class="w-4 h-4 text-blue-500/60" />
                        
                    <input 
                      v-if="editingChatGroupId === element.chatGroup.id"
                      v-focus
                      v-model="editingChatGroupName"
                      @keydown.enter="$event => !$event.isComposing && saveChatGroupRename()"
                      @keyup.esc="editingChatGroupId = null"
                      @blur="saveChatGroupRename"
                      @click.stop
                      class="bg-white dark:bg-gray-700 text-gray-800 dark:text-white text-sm px-2 py-0.5 rounded-lg w-full outline-none ring-2 ring-blue-500/50 pointer-events-auto font-medium shadow-sm"
                      data-testid="chat-group-rename-input"
                    />
                    <span v-else class="truncate text-sm font-bold tracking-tight">{{ element.chatGroup.name }}</span>
                  </div>
                      
                  <div class="flex items-center group-action-container" :class="activeActionGroupId === element.chatGroup.id ? 'opacity-100' : 'opacity-0 group-hover/folder:opacity-100 transition-opacity'">
                    <button v-if="editingChatGroupId !== element.chatGroup.id" @click.stop="startEditingChatGroup(element.chatGroup)" class="p-1 hover:text-blue-600 dark:hover:text-white" title="Rename Group"><Pencil class="w-3 h-3" /></button>
                    
                    <ChatGroupActions
                      :chat-group="element.chatGroup"
                      :is-open="activeActionGroupId === element.chatGroup.id"
                      @toggle="activeActionGroupId = activeActionGroupId === element.chatGroup.id ? null : element.chatGroup.id"
                      @duplicate="() => { chatStore.duplicateChatGroup(element.chatGroup.id); activeActionGroupId = null; }"
                      @delete="() => { handleDeleteChatGroup(element.chatGroup); activeActionGroupId = null; }"
                    />
                  </div>
                </div>

                <!-- Nested Items in Chat Group -->
                <div class="grid transition-all duration-200 ease-in-out" :style="{ gridTemplateRows: element.chatGroup.isCollapsed ? '0fr' : '1fr' }">
                  <div class="ml-4 pl-2 border-l border-gray-100 dark:border-gray-800 mt-1 space-y-0.5 overflow-hidden min-h-0">
                    <button 
                      @click.stop="handleNewChat(element.chatGroup.id)"
                      class="w-full flex items-center gap-2 text-[10px] text-gray-400 hover:text-blue-600 p-2 transition-colors font-medium"
                    >
                      <SquarePen class="w-3 h-3" /> Add Chat
                    </button>
                      
                    <!-- Smooth height for Show more/less -->
                    <div 
                      class="transition-[max-height] duration-400 ease-in-out overflow-hidden"
                      :style="{ maxHeight: isGroupCompactExpanded(element.chatGroup.id) ? '2000px' : '250px' }"
                    >
                      <draggable
                        v-model="useGroupItemsModel(element.chatGroup.id).value"
                        :group="{ name: 'sidebar' }"
                        item-key="id"
                        handle=".handle"
                        :animation="0"
                        :delay="200"
                        :delay-on-touch-only="true"
                        tag="div"
                        data-testid="nested-draggable"
                        @start="onDragStart"
                        @end="onDragEnd"
                        ghost-class="sortable-ghost"
                        :class="['nested-draggable space-y-0.5', isDragging ? 'min-h-[40px] pb-4' : 'min-h-[20px]']"
                        :swap-threshold="0.5"
                        :invert-swap="true"
                        :scroll="true"
                        :scroll-sensitivity="100"
                        :scroll-speed="20"
                        :force-fallback="true"
                        fallback-class="opacity-0"
                      >
                        <template #item="{ element: nestedItem }">
                          <div 
                            @click="handleOpenChat(nestedItem.chat.id)"
                            class="group/chat flex items-center justify-between p-2 rounded-xl cursor-pointer handle sidebar-chat-item"
                            :class="focusedId === nestedItem.chat.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200'"
                            :data-testid="'sidebar-chat-item-' + nestedItem.chat.id"
                          >
                            <div class="flex items-center gap-3 overflow-hidden flex-1 pointer-events-none">
                              <input 
                                v-if="editingId === nestedItem.chat.id"
                                v-focus
                                v-model="editingTitle"
                                @keydown.enter="$event => !$event.isComposing && saveRename()"
                                @keyup.esc="editingId = null"
                                @blur="saveRename"
                                @click.stop
                                class="bg-white dark:bg-gray-700 text-gray-800 dark:text-white text-sm px-2 py-0.5 rounded-lg w-full outline-none ring-2 ring-blue-500/50 pointer-events-auto shadow-sm"
                                data-testid="chat-rename-input"
                              />
                              <span v-else class="truncate text-sm">{{ nestedItem.chat.title || 'New Chat' }}</span>
                            </div>
                            <div class="flex items-center gap-1">
                              <Loader2 v-if="isProcessing(nestedItem.chat.id)" class="w-3 h-3 text-blue-500 animate-spin mr-1 shrink-0" />
                              <div v-if="editingId !== nestedItem.chat.id" class="flex items-center opacity-0 group-hover/chat:opacity-100 transition-opacity">
                                <button @click.stop="startEditing(nestedItem.chat.id, nestedItem.chat.title)" class="p-1 hover:text-blue-600 dark:hover:text-blue-400"><Pencil class="w-3 h-3" /></button>
                                <button @click.stop="handleDeleteChat(nestedItem.chat.id)" class="p-1 hover:text-red-500"><Trash2 class="w-3 h-3" /></button>
                              </div>
                            </div>
                          </div>
                        </template>
                      </draggable>
                    </div>

                    <!-- Compact View: Show More/Less Button -->
                    <button 
                      v-if="element.chatGroup.items.length > COMPACT_THRESHOLD"
                      @click.stop="toggleGroupCompactExpansion(element.chatGroup.id)"
                      class="w-full flex items-center justify-between p-2 rounded-xl text-[10px] font-bold focus:outline-none transition-all"
                      :class="[
                        focusedId === `expand-${element.chatGroup.id}`
                          ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 shadow-sm'
                          : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/50',
                        !isGroupCompactExpanded(element.chatGroup.id) ? 'bg-gradient-to-b from-transparent to-gray-50/30 dark:to-gray-800/20' : ''
                      ]"
                      data-testid="show-more-button"
                    >
                      <span class="ml-1 flex items-center gap-1.5">
                        <MoreHorizontal v-if="!isGroupCompactExpanded(element.chatGroup.id)" class="w-3 h-3 opacity-60" />
                        {{ isGroupCompactExpanded(element.chatGroup.id) ? 'Show less' : `Show ${element.chatGroup.items.length - COMPACT_THRESHOLD} more` }}
                      </span>
                      <component :is="isGroupCompactExpanded(element.chatGroup.id) ? ChevronUp : ChevronDown" class="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Top-level Individual Chat -->
              <div 
                v-else
                @click="handleOpenChat(element.chat.id)"
                class="group/chat flex items-center justify-between p-2 rounded-xl cursor-pointer handle sidebar-chat-item"
                :class="focusedId === element.chat.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200'"
                :data-testid="'sidebar-chat-item-' + element.chat.id"
              >
                <div class="flex items-center gap-3 overflow-hidden flex-1 pointer-events-none">
                  <input 
                    v-if="editingId === element.chat.id"
                    v-focus
                    v-model="editingTitle"
                    @keydown.enter="$event => !$event.isComposing && saveRename()"
                    @keyup.esc="editingId = null"
                    @blur="saveRename"
                    @click.stop
                    class="bg-white dark:bg-gray-700 text-gray-800 dark:text-white text-sm px-2 py-0.5 rounded-lg w-full outline-none ring-2 ring-blue-500/50 pointer-events-auto shadow-sm"
                    data-testid="chat-rename-input"
                  />
                  <span v-else class="truncate text-sm">{{ element.chat.title || 'New Chat' }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <Loader2 v-if="isProcessing(element.chat.id)" class="w-3 h-3 text-blue-500 animate-spin mr-1 shrink-0" />
                  <div v-if="editingId !== element.chat.id" class="flex items-center opacity-0 group-hover/chat:opacity-100 transition-opacity">
                    <button @click.stop="startEditing(element.chat.id, element.chat.title)" class="p-1 hover:text-blue-600 dark:hover:text-blue-400"><Pencil class="w-3 h-3" /></button>
                    <button @click.stop="handleDeleteChat(element.chat.id)" class="p-1 hover:text-red-500"><Trash2 class="w-3 h-3" /></button>
                  </div>
                </div>
              </div>
            </div>
          </template>        </draggable>
      </template>
    </div>

    <!-- Footer -->
    <div class="border-t border-gray-100 dark:border-gray-800 space-y-4 bg-gray-50/30 dark:bg-black/20" :class="isSidebarOpen ? 'p-3' : 'py-3 px-1'">
      <!-- Global Model Selector -->
      <div v-if="isSidebarOpen && (settings.endpointUrl || settings.endpointType === 'transformers_js')" class="px-1 space-y-2 animate-in fade-in duration-300">
        <div class="flex items-center justify-between px-1">
          <label class="flex items-center gap-2 text-[11px] font-semibold text-gray-400 dark:text-gray-500">
            <Bot class="w-3 h-3" />
            Default model
          </label>
        </div>
        <ModelSelector 
          :model-value="settings.defaultModelId || ''"
          :models="sortedModels"
          :loading="isFetchingModels"
          @update:model-value="handleGlobalModelChange"
          placeholder="Select default model"
        />
      </div>

      <div class="flex items-center gap-2" :class="{ 'flex-col items-center': !isSidebarOpen }">
        <button 
          @click="router.push({ query: { ...route.query, settings: 'connection' } })" 
          class="flex items-center justify-center gap-2 text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm"
          :class="isSidebarOpen ? 'flex-1 py-3 px-2' : 'w-8 h-8'"
          title="Settings"
          data-testid="sidebar-settings-button"
        >
          <SettingsIcon class="w-4 h-4 shrink-0" />
          <span v-if="isSidebarOpen">Settings</span>
        </button>
        
        <SidebarDebugControls :is-sidebar-open="isSidebarOpen" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nested-draggable {
  min-height: 20px;
}

/* New chat group creation transition - seamless swap */
.chat-group-new-enter-active {
  transition: all 0.2s ease-out;
}
.chat-group-new-leave-active {
  transition: all 0.2s ease-in;
}

/* Instant disappearance when skip-leave class is present */
.skip-leave.chat-group-new-leave-active {
  transition: none !important;
}

.chat-group-new-enter-from {
  opacity: 0;
  transform: translateY(-10px);
}

.chat-group-new-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.handle {
  cursor: grab;
}

.handle:active {
  cursor: grabbing;
}

.sidebar-chat-item, 
.is-group > div:first-child {
  scroll-margin-top: 48px;
  scroll-margin-bottom: 48px;
}

.sortable-ghost {
  opacity: 0.3;
  background: rgb(59 130 246 / 0.1);
  border: 2px dashed rgb(59 130 246 / 0.5);
  border-radius: 0.75rem;
}

/* Reordering is always instant */
.list-move {
  transition: none !important;
}

/* Ensure the dragged element itself doesn't have transitions */
.sortable-drag {
  transition: none !important;
}

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.fade-in {
  animation-name: fade-in;
}
</style>