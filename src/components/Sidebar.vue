<script setup lang="ts">
import { onMounted, ref, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import draggable from 'vuedraggable';
import { useChat } from '../composables/useChat';
import { useTheme } from '../composables/useTheme';
import Logo from './Logo.vue';
import type { ChatGroup, SidebarItem } from '../models/types';
import { 
  Plus, Trash2, Settings as SettingsIcon, Sun, Moon, Monitor, 
  RotateCcw, Pencil, Folder, FolderPlus, 
  ChevronDown, ChevronRight, Check, X
} from 'lucide-vue-next';

const chatStore = useChat();
const { 
  currentChat, lastDeletedChat, streaming, groups, chats
} = chatStore;

const { themeMode, setTheme } = useTheme();
const router = useRouter();

const sidebarItemsLocal = ref<SidebarItem[]>([]);
const isDragging = ref(false);
let isInternalUpdate = false;

const editingId = ref<string | null>(null);
const editingTitle = ref('');
const isCreatingGroup = ref(false);
const newGroupName = ref('');
const editingGroupId = ref<string | null>(null);
const editingGroupName = ref('');

onMounted(async () => {
  await chatStore.loadChats();
  syncLocalItems();
});

function syncLocalItems() {
  if (isDragging.value || isInternalUpdate) return;
  // Use a fresh copy to decouple from store reactivity during DND
  sidebarItemsLocal.value = JSON.parse(JSON.stringify(chatStore.sidebarItems.value));
}

// Watch for external changes (new chats, deletions) to sync local list
watch([groups, chats], () => {
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
 * Only chats can be moved into groups. Groups cannot be nested.
 */
function checkMove(evt: { draggedContext: { element: SidebarItem }; to: HTMLElement }) {
  const draggedItem = evt.draggedContext.element;
  // If dragging into a nested list (a group's items)
  if (evt.to.classList.contains('nested-draggable')) {
    // Only allow chats
    return draggedItem.type === 'chat';
  }
  return true;
}

// --- Actions ---

async function handleCreateGroup() {
  const name = newGroupName.value.trim() || 'New Group';
  await chatStore.createGroup(name);
  newGroupName.value = '';
  isCreatingGroup.value = false;
}

async function handleNewChat(groupId: string | null = null) {
  await chatStore.createNewChat(groupId);
  if (currentChat.value) {
    router.push(`/chat/${currentChat.value.id}`);
  }
}

function handleOpenChat(id: string) {
  if (editingId.value === id) return;
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

function startEditingGroup(group: ChatGroup) {
  editingGroupId.value = group.id;
  editingGroupName.value = group.name;
}

async function saveGroupRename() {
  if (editingGroupId.value && editingGroupName.value.trim()) {
    await chatStore.renameGroup(editingGroupId.value, editingGroupName.value.trim());
  }
  editingGroupId.value = null;
}

async function handleDeleteAll() {
  if (confirm('Are you absolutely sure you want to delete ALL chats and groups?')) {
    await chatStore.deleteAllChats();
    router.push('/');
  }
}

async function handleUndo() {
  await chatStore.undoDelete();
  if (currentChat.value) {
    router.push(`/chat/${currentChat.value.id}`);
  }
}
</script>

<template>
  <div class="flex flex-col h-full bg-gray-900 text-white w-64 border-r border-gray-800 select-none">
    <!-- Header -->
    <div class="p-6 pb-2 flex items-center gap-3">
      <Logo :size="28" />
      <h1 class="text-lg font-bold tracking-tight bg-gradient-to-br from-white to-gray-400 bg-clip-text text-transparent">
        LM Web UI
      </h1>
    </div>

    <!-- Actions -->
    <div class="p-4 space-y-2">
      <div class="flex gap-2">
        <button 
          @click="handleNewChat(null)"
          class="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium"
          :disabled="streaming"
          data-testid="new-chat-button"
        >
          <Plus class="w-4 h-4" />
          New Chat
        </button>
        <button 
          @click="isCreatingGroup = true"
          class="p-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
          title="Create Group"
          data-testid="create-group-button"
        >
          <FolderPlus class="w-4 h-4" />
        </button>
      </div>

      <div v-if="isCreatingGroup" class="flex items-center gap-1 p-2 bg-gray-800 rounded-lg border border-indigo-500/50">
        <input 
          v-model="newGroupName"
          @keyup.enter="handleCreateGroup"
          @keyup.esc="isCreatingGroup = false"
          class="bg-transparent text-xs text-white outline-none w-full px-1"
          placeholder="Group name..."
          auto-focus
          data-testid="group-name-input"
        />
        <button @click="handleCreateGroup" class="text-green-400 hover:text-green-300" data-testid="confirm-create-group">
          <Check class="w-3 h-3" />
        </button>
        <button @click="isCreatingGroup = false" class="text-red-400 hover:text-red-300">
          <X class="w-3 h-3" />
        </button>
      </div>

      <button 
        v-if="lastDeletedChat"
        @click="handleUndo"
        class="w-full flex items-center justify-center gap-2 bg-green-600/20 hover:bg-green-600/30 text-green-400 px-4 py-2 rounded-lg transition-colors text-sm border border-green-600/30"
        data-testid="undo-delete-button"
      >
        <RotateCcw class="w-4 h-4" />
        Undo Delete
      </button>
    </div>

    <!-- Navigation List -->
    <div class="flex-1 overflow-y-auto px-2 py-2">
      <draggable 
        v-model="sidebarItemsLocal" 
        item-key="id"
        handle=".handle"
        :group="{ name: 'sidebar' }"
        :move="checkMove"
        @start="onDragStart"
        @end="onDragEnd"
        ghost-class="opacity-50"
        class="space-y-4 min-h-[100px]"
      >
        <template #item="{ element }">
          <div :class="{ 'is-group': element.type === 'group' }">
            <!-- Group Item -->
            <div v-if="element.type === 'group'" class="space-y-1">
              <div 
                @click="chatStore.toggleGroupCollapse(element.group.id)"
                class="flex items-center justify-between p-2 rounded-lg hover:bg-gray-800 cursor-pointer text-gray-400 group/folder relative transition-all handle"
                data-testid="group-item"
              >
                <div class="flex items-center gap-2 overflow-hidden flex-1 pointer-events-none">
                  <component :is="element.group.isCollapsed ? ChevronRight : ChevronDown" class="w-3 h-3 flex-shrink-0" />
                  <Folder class="w-4 h-4 text-indigo-400/70" />
                  
                  <input 
                    v-if="editingGroupId === element.group.id"
                    v-model="editingGroupName"
                    @keyup.enter="saveGroupRename"
                    @keyup.esc="editingGroupId = null"
                    @click.stop
                    class="bg-gray-700 text-white text-xs px-1 py-0.5 rounded w-full outline-none focus:ring-1 focus:ring-indigo-500 pointer-events-auto"
                    auto-focus
                  />
                  <span v-else class="truncate text-xs font-bold tracking-tight">{{ element.group.name }}</span>
                </div>
                
                <div class="flex items-center opacity-0 group-hover/folder:opacity-100 transition-opacity">
                  <button v-if="editingGroupId !== element.group.id" @click.stop="startEditingGroup(element.group)" class="p-1 hover:text-white"><Pencil class="w-3 h-3" /></button>
                  <button @click.stop="chatStore.deleteGroup(element.group.id)" class="p-1 hover:text-red-400"><Trash2 class="w-3 h-3" /></button>
                </div>
              </div>

              <!-- Nested Items in Group -->
              <div v-if="!element.group.isCollapsed" class="ml-4 pl-2 border-l border-gray-800 mt-1 space-y-0.5">
                <draggable
                  v-model="element.group.items"
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
                        class="group/chat flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors handle"
                        :class="currentChat?.id === nestedItem.chat.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'"
                        data-testid="sidebar-chat-item"
                      >
                        <div class="flex items-center gap-3 overflow-hidden flex-1 pointer-events-none">
                          <input 
                            v-if="editingId === nestedItem.chat.id"
                            v-model="editingTitle"
                            @keyup.enter="saveRename"
                            @keyup.esc="editingId = null"
                            @click.stop
                            class="bg-gray-700 text-white text-sm px-1 py-0.5 rounded w-full outline-none focus:ring-1 focus:ring-indigo-500 pointer-events-auto"
                            auto-focus
                          />
                          <span v-else class="truncate text-sm">{{ nestedItem.chat.title || 'Untitled Chat' }}</span>
                        </div>
                        <div v-if="editingId !== nestedItem.chat.id" class="flex items-center opacity-0 group-hover/chat:opacity-100 transition-opacity">
                          <button @click.stop="startEditing(nestedItem.chat.id, nestedItem.chat.title)" class="p-1 hover:text-indigo-400"><Pencil class="w-3 h-3" /></button>
                          <button @click.stop="handleDeleteChat(nestedItem.chat.id)" class="p-1 hover:text-red-400"><Trash2 class="w-3 h-3" /></button>
                        </div>
                      </div>
                    </div>
                  </template>
                </draggable>
                <button 
                  @click="handleNewChat(element.group.id)"
                  class="w-full flex items-center gap-2 text-[10px] text-gray-600 hover:text-gray-400 p-2 transition-colors"
                >
                  <Plus class="w-3 h-3" /> Add Chat
                </button>
              </div>
            </div>

            <!-- Top-level Individual Chat -->
            <div 
              v-else
              @click="handleOpenChat(element.chat.id)"
              class="group/chat flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors handle"
              :class="currentChat?.id === element.chat.id ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'"
              data-testid="sidebar-chat-item"
            >
              <div class="flex items-center gap-3 overflow-hidden flex-1 pointer-events-none">
                <input 
                  v-if="editingId === element.chat.id"
                  v-model="editingTitle"
                  @keyup.enter="saveRename"
                  @keyup.esc="editingId = null"
                  @click.stop
                  class="bg-gray-700 text-white text-sm px-1 py-0.5 rounded w-full outline-none focus:ring-1 focus:ring-indigo-500 pointer-events-auto"
                  auto-focus
                />
                <span v-else class="truncate text-sm">{{ element.chat.title || 'Untitled Chat' }}</span>
              </div>
              <div v-if="editingId !== element.chat.id" class="flex items-center opacity-0 group-hover/chat:opacity-100 transition-opacity">
                <button @click.stop="startEditing(element.chat.id, element.chat.title)" class="p-1 hover:text-indigo-400"><Pencil class="w-3 h-3" /></button>
                <button @click.stop="handleDeleteChat(element.chat.id)" class="p-1 hover:text-red-400"><Trash2 class="w-3 h-3" /></button>
              </div>
            </div>
          </div>
        </template>
      </draggable>
    </div>

    <!-- Footer -->
    <div class="p-4 border-t border-gray-800 space-y-4">
      <button 
        v-if="chats.length > 0 || groups.length > 0"
        @click="handleDeleteAll"
        class="flex items-center gap-2 text-xs text-gray-600 hover:text-red-400 w-full px-2 py-1 rounded hover:bg-red-900/10 transition-colors"
        data-testid="clear-all-button"
      >
        <Trash2 class="w-3 h-3" />
        Clear All History
      </button>

      <div class="flex items-center justify-between bg-gray-800 p-1 rounded-lg">
        <button @click="setTheme('light')" class="flex-1 flex justify-center py-1.5 rounded-md transition-all" :class="themeMode === 'light' ? 'bg-gray-700 text-yellow-400 shadow-sm' : 'text-gray-400 hover:text-gray-200'"><Sun class="w-4 h-4" /></button>
        <button @click="setTheme('dark')" class="flex-1 flex justify-center py-1.5 rounded-md transition-all" :class="themeMode === 'dark' ? 'bg-gray-700 text-indigo-400 shadow-sm' : 'text-gray-400 hover:text-gray-200'"><Moon class="w-4 h-4" /></button>
        <button @click="setTheme('system')" class="flex-1 flex justify-center py-1.5 rounded-md transition-all" :class="themeMode === 'system' ? 'bg-gray-700 text-green-400 shadow-sm' : 'text-gray-400 hover:text-gray-200'"><Monitor class="w-4 h-4" /></button>
      </div>

      <button @click="$emit('open-settings')" class="flex items-center gap-2 text-sm text-gray-400 hover:text-white w-full px-2 py-2 rounded hover:bg-gray-800"><SettingsIcon class="w-4 h-4" />Settings</button>
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
</style>