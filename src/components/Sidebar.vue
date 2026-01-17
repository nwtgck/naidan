<script setup lang="ts">
import { onMounted, ref, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import draggable from 'vuedraggable';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import Logo from './Logo.vue';
import ThemeToggle from './ThemeToggle.vue';
import ModelSelector from './ModelSelector.vue';
import type { ChatGroup, SidebarItem } from '../models/types';
import { 
  Plus, Trash2, Settings as SettingsIcon, 
  Pencil, Folder, FolderPlus, 
  ChevronDown, ChevronRight, Check, X,
  Bot, PanelLeft, SquarePen, Loader2,
} from 'lucide-vue-next';
import { useLayout } from '../composables/useLayout';

const chatStore = useChat();
const { 
  currentChat, chatGroups, chats, activeGenerations,
} = chatStore;

const { settings, isFetchingModels, save: saveSettings } = useSettings();
const { isSidebarOpen, toggleSidebar } = useLayout();

const router = useRouter();

defineEmits<{
  (e: 'open-settings'): void
}>();

const sidebarItemsLocal = ref<SidebarItem[]>([]);
const isDragging = ref(false);
let isInternalUpdate = false;

const editingId = ref<string | null>(null);
const editingTitle = ref('');
const isCreatingChatGroup = ref(false);
const newChatGroupName = ref('');
const editingChatGroupId = ref<string | null>(null);
const editingChatGroupName = ref('');
const skipLeaveAnimation = ref(false);

// Custom directive for auto-focusing elements
const vFocus = {
  mounted: (el: HTMLElement) => el.focus(),
};

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const newChatShortcutText = isMac ? '⌘⇧O' : 'Ctrl+Shift+O';
const appVersion = __APP_VERSION__;

onMounted(() => {
  syncLocalItems();
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
  // Sync the UI structure to storage
  await chatStore.persistSidebarStructure(sidebarItemsLocal.value);
  
  // Wait for DOM and Sortable cleanup
  await nextTick();
  isDragging.value = false;
  setTimeout(() => {
    isInternalUpdate = false;
  }, 100);
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
    return draggedItem.type === 'chat';
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
  setTimeout(() => { skipLeaveAnimation.value = false; }, 200);
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

async function handleNewChat(chatGroupId: string | null = null) {
  await chatStore.createNewChat(chatGroupId);
  if (currentChat.value) {
    router.push(`/chat/${currentChat.value.id}`);
  }
}

function handleOpenChat(id: string) {
  if (editingId.value === id) return;
  chatStore.currentChatGroup.value = null;
  router.push(`/chat/${id}`);
}

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
  await saveSettings({
    ...settings.value,
    defaultModelId: newModelId,
  });
}
</script>

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
          @click="handleNewChat(null)"
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
    <div class="flex-1 overflow-y-auto px-3 py-2 scrollbar-hide" data-testid="sidebar-nav">
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
          :group="{ name: 'sidebar' }"
          :move="checkMove"
          @start="onDragStart"
          @end="onDragEnd"
          ghost-class="opacity-50"
          class="space-y-1 min-h-[100px]"
        >
          <template #item="{ element }">
            <div :class="{ 'is-group': element.type === 'chat_group' }">
              <!-- Chat Group Item -->
              <div v-if="element.type === 'chat_group'" class="space-y-1">
                <div 
                  @click="chatStore.openChatGroup(element.chatGroup.id)"
                  class="flex items-center justify-between p-2 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer text-gray-500 dark:text-gray-400 group/folder relative transition-all handle"
                  :class="{ 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm': chatStore.currentChatGroup.value?.id === element.chatGroup.id }"
                  data-testid="chat-group-item"
                >
                  <div class="flex items-center gap-2 overflow-hidden flex-1 pointer-events-none">
                    <button 
                      @click.stop="chatStore.toggleChatGroupCollapse(element.chatGroup.id)"
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
                  
                  <div class="flex items-center opacity-0 group-hover/folder:opacity-100 transition-opacity">
                    <button v-if="editingChatGroupId !== element.chatGroup.id" @click.stop="startEditingChatGroup(element.chatGroup)" class="p-1 hover:text-blue-600 dark:hover:text-white"><Pencil class="w-3 h-3" /></button>
                    <button @click.stop="chatStore.deleteChatGroup(element.chatGroup.id)" class="p-1 hover:text-red-500"><Trash2 class="w-3 h-3" /></button>
                  </div>
                </div>

                <!-- Nested Items in Chat Group -->
                <div v-if="!element.chatGroup.isCollapsed" class="ml-4 pl-2 border-l border-gray-100 dark:border-gray-800 mt-1 space-y-0.5">
                  <draggable
                    v-model="element.chatGroup.items"
                    :group="{ name: 'sidebar' }"
                    item-key="id"
                    @start="onDragStart"
                    @end="onDragEnd"
                    ghost-class="opacity-50"
                    class="nested-draggable min-h-[20px] space-y-0.5"
                  >
                    <template #item="{ element: nestedItem }">
                      <div v-if="nestedItem.type === 'chat'">
                        <div 
                          @click="handleOpenChat(nestedItem.chat.id)"
                          class="group/chat flex items-center justify-between p-2 rounded-xl cursor-pointer transition-all handle sidebar-chat-item"
                          :class="currentChat?.id === nestedItem.chat.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200'"
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
                            <Loader2 v-if="activeGenerations.has(nestedItem.chat.id)" class="w-3 h-3 text-blue-500 animate-spin mr-1 shrink-0" />
                            <div v-if="editingId !== nestedItem.chat.id" class="flex items-center opacity-0 group-hover/chat:opacity-100 transition-opacity">
                              <button @click.stop="startEditing(nestedItem.chat.id, nestedItem.chat.title)" class="p-1 hover:text-blue-600 dark:hover:text-blue-400"><Pencil class="w-3 h-3" /></button>
                              <button @click.stop="handleDeleteChat(nestedItem.chat.id)" class="p-1 hover:text-red-500"><Trash2 class="w-3 h-3" /></button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </template>
                  </draggable>
                  <button 
                    @click="handleNewChat(element.chatGroup.id)"
                    class="w-full flex items-center gap-2 text-[10px] text-gray-400 hover:text-blue-600 p-2 transition-colors font-medium"
                  >
                    <Plus class="w-3 h-3" /> Add Chat
                  </button>
                </div>
              </div>

              <!-- Top-level Individual Chat -->
              <div 
                v-else
                @click="handleOpenChat(element.chat.id)"
                class="group/chat flex items-center justify-between p-2 rounded-xl cursor-pointer transition-all handle sidebar-chat-item"
                :class="currentChat?.id === element.chat.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/50 hover:text-gray-800 dark:hover:text-gray-200'"
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
                  <Loader2 v-if="activeGenerations.has(element.chat.id)" class="w-3 h-3 text-blue-500 animate-spin mr-1 shrink-0" />
                  <div v-if="editingId !== element.chat.id" class="flex items-center opacity-0 group-hover/chat:opacity-100 transition-opacity">
                    <button @click.stop="startEditing(element.chat.id, element.chat.title)" class="p-1 hover:text-blue-600 dark:hover:text-blue-400"><Pencil class="w-3 h-3" /></button>
                    <button @click.stop="handleDeleteChat(element.chat.id)" class="p-1 hover:text-red-500"><Trash2 class="w-3 h-3" /></button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </draggable>
      </template>
    </div>

    <!-- Footer -->
    <div class="border-t border-gray-100 dark:border-gray-800 space-y-4 bg-gray-50/30 dark:bg-black/20" :class="isSidebarOpen ? 'p-3' : 'py-3 px-1'">
      <!-- Global Model Selector -->
      <div v-if="isSidebarOpen && settings.endpointUrl" class="px-1 space-y-2 animate-in fade-in duration-300">
        <div class="flex items-center justify-between px-1">
          <label class="flex items-center gap-2 text-[11px] font-semibold text-gray-400 dark:text-gray-500">
            <Bot class="w-3 h-3" />
            Default model
          </label>
        </div>
        <ModelSelector 
          :model-value="settings.defaultModelId || ''"
          :loading="isFetchingModels"
          @update:model-value="handleGlobalModelChange"
          placeholder="Select default model"
        />
      </div>

      <div class="flex items-center gap-2" :class="{ 'flex-col items-center': !isSidebarOpen }">
        <button 
          @click="$emit('open-settings')" 
          class="flex items-center justify-center gap-2 text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-white rounded-xl hover:bg-white dark:hover:bg-gray-800 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all shadow-sm"
          :class="isSidebarOpen ? 'flex-1 py-3 px-2' : 'w-8 h-8'"
          title="Settings"
        >
          <SettingsIcon class="w-4 h-4 shrink-0" />
          <span v-if="isSidebarOpen">Settings</span>
        </button>
        <div v-if="isSidebarOpen" class="w-32 flex-shrink-0 animate-in fade-in duration-300">
          <ThemeToggle />
        </div>
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
