<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { 
  X, Save, Plus, Trash2, 
  User, Bot, Settings,
  GripVertical, History, Hammer, Cpu
} from 'lucide-vue-next';
import { useChat } from '../composables/useChat';
import type { HistoryItem } from '../utils/chat-tree';
import { useLayout } from '../composables/useLayout';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const chatStore = useChat();
const { currentChat, activeMessages } = chatStore;
const { setActiveFocusArea } = useLayout();

const editableMessages = ref<HistoryItem[]>([]);

watch(() => props.isOpen, (open) => {
  if (open && currentChat.value) {
    setActiveFocusArea('dialog');
    // Deep copy current branch to editable state
    editableMessages.value = activeMessages.value.map(m => ({
      role: m.role,
      content: m.content,
      modelId: m.modelId,
      thinking: m.thinking,
      attachments: m.attachments ? [...m.attachments] : undefined
    }));
  } else {
    setActiveFocusArea('chat');
  }
});

function addMessage(index: number) {
  editableMessages.value.splice(index + 1, 0, {
    role: 'user',
    content: ''
  });
}

function removeMessage(index: number) {
  editableMessages.value.splice(index, 1);
}

async function handleSave() {
  if (!currentChat.value) return;
  
  await chatStore.commitFullHistoryManipulation(currentChat.value.id, editableMessages.value);
  emit('close');
}

function handleCancel() {
  emit('close');
}
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" class="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 md:p-6" @click.self="handleCancel">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 modal-content-zoom overflow-hidden">
        <!-- Header -->
        <div class="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-gray-800/50">
          <div class="flex items-center gap-3">
            <div class="p-2 bg-orange-50 dark:bg-orange-900/20 rounded-xl text-orange-600">
              <Hammer class="w-5 h-5" />
            </div>
            <div>
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Super Edit</h2>
              <p class="text-xs text-gray-500 dark:text-gray-400 font-medium">Manipulate full chat history. A new branch will be created.</p>
            </div>
          </div>
          <button @click="handleCancel" class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors">
            <X class="w-5 h-5" />
          </button>
        </div>

        <!-- Message List -->
        <div class="flex-1 overflow-y-auto p-6 space-y-6">
          <div v-if="editableMessages.length === 0" class="h-full flex flex-col items-center justify-center text-gray-400 gap-4">
            <History class="w-12 h-12 opacity-20" />
            <p>No messages in history. Add one to start.</p>
            <button @click="addMessage(-1)" class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all font-bold text-sm">
              <Plus class="w-4 h-4" />
              Add First Message
            </button>
          </div>
          
          <div v-for="(msg, index) in editableMessages" :key="index" class="relative group">
            <div class="flex gap-4 items-start">
              <!-- Role Selector & Drag Handle (Placeholder) -->
              <div class="flex flex-col items-center gap-2 pt-2">
                <button 
                  @click="msg.role = msg.role === 'user' ? 'assistant' : 'user'"
                  class="p-2 rounded-xl transition-all shadow-sm border"
                  :class="{
                    'bg-blue-50 dark:bg-blue-900/20 text-blue-600 border-blue-100 dark:border-blue-800': msg.role === 'user',
                    'bg-purple-50 dark:bg-purple-900/20 text-purple-600 border-purple-100 dark:border-purple-800': msg.role === 'assistant'
                  }"
                  :title="'Switch Role (Current: ' + msg.role + ')'"
                >
                  <User v-if="msg.role === 'user'" class="w-4 h-4" />
                  <Bot v-else class="w-4 h-4" />
                </button>
                <div class="text-[10px] font-bold uppercase tracking-tighter opacity-50">{{ msg.role }}</div>
              </div>

              <!-- Content Area -->
              <div class="flex-1 bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-100 dark:border-gray-700 overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all">
                <textarea 
                  v-model="msg.content"
                  class="w-full bg-transparent p-4 text-sm text-gray-800 dark:text-gray-100 focus:outline-none resize-none min-h-[100px]"
                  placeholder="Message content..."
                ></textarea>
                
                <!-- Metadata/Info Bar -->
                <div v-if="msg.modelId || msg.thinking" class="px-4 py-2 bg-gray-100/50 dark:bg-gray-800 flex gap-4 text-[10px] font-mono text-gray-500 border-t dark:border-gray-700">
                  <span v-if="msg.modelId" class="flex items-center gap-1"><Cpu class="w-3 h-3" /> {{ msg.modelId }}</span>
                  <span v-if="msg.thinking" class="flex items-center gap-1 truncate"><History class="w-3 h-3" /> Has Thinking Content</span>
                </div>
              </div>

              <!-- Actions -->
              <div class="flex flex-col gap-2 transition-opacity">
                <button @click="removeMessage(index)" class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors" title="Remove Message">
                  <Trash2 class="w-4 h-4" />
                </button>
                <button @click="addMessage(index)" class="p-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors" title="Add Message After">
                  <Plus class="w-4 h-4" />
                </button>
              </div>
            </div>
            
            <!-- Connection Line -->
            <div v-if="index < editableMessages.length - 1" class="absolute left-[21px] top-[48px] bottom-[-24px] w-0.5 bg-gray-100 dark:bg-gray-800 -z-10"></div>
          </div>

          <div v-if="editableMessages.length > 0" class="flex justify-center pt-4">
            <button @click="addMessage(editableMessages.length - 1)" class="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-blue-600 transition-colors font-bold text-xs uppercase tracking-widest">
              <Plus class="w-4 h-4" />
              Append Message
            </button>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-6 py-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end gap-3 bg-gray-50/50 dark:bg-gray-800/50">
          <button @click="handleCancel" class="px-4 py-2 text-sm font-bold text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors">
            Cancel
          </button>
          <button 
            @click="handleSave" 
            :disabled="editableMessages.length === 0"
            class="flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-blue-500/30 font-bold text-sm"
          >
            <Save class="w-4 h-4" />
            Apply Changes
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: all 0.3s ease;
}

.modal-enter-active .modal-content-zoom,
.modal-leave-active .modal-content-zoom {
  transition: all 0.3s cubic-bezier(0.34, 1.05, 0.64, 1);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-content-zoom,
.modal-leave-to .modal-content-zoom {
  transform: scale(0.95);
  opacity: 0;
}

textarea {
  scrollbar-width: thin;
}
</style>
