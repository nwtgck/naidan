<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { 
  X, Save, Plus, Trash2, 
  User, Bot, Hammer, Cpu,
  Paperclip, Image as ImageIcon, History
} from 'lucide-vue-next';
import { useChat } from '../composables/useChat';
import type { HistoryItem } from '../utils/chat-tree';
import { useLayout } from '../composables/useLayout';
import type { Attachment } from '../models/types';
import { storageService } from '../services/storage';

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
const attachmentUrls = ref<Record<string, string>>({});
const fileInputs = ref<(HTMLInputElement | null)[]>([]);

function setFileInputRef(el: unknown, index: number) {
  fileInputs.value[index] = el as HTMLInputElement | null;
}

watch(() => props.isOpen, async (open) => {
  if (open && currentChat.value) {
    setActiveFocusArea('dialog');
    
    // Clear old URLs
    Object.values(attachmentUrls.value).forEach(URL.revokeObjectURL);
    attachmentUrls.value = {};

    // Deep copy current branch to editable state
    editableMessages.value = activeMessages.value.map(m => ({
      role: m.role,
      content: m.content,
      modelId: m.modelId,
      thinking: m.thinking,
      attachments: m.attachments ? [...m.attachments] : undefined
    }));

    // Generate preview URLs for existing attachments
    for (const msg of editableMessages.value) {
      if (msg.attachments) {
        for (const att of msg.attachments) {
          const status = att.status;
          switch (status) {
          case 'persisted': {
            const blob = await storageService.getFile(att.id, att.originalName);
            if (blob) {
              attachmentUrls.value[att.id] = URL.createObjectURL(blob);
            }
            break;
          }
          case 'memory':
            attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
            break;
          case 'missing':
            break;
          default: {
            const _ex: never = status;
            throw new Error(`Unhandled attachment status: ${_ex}`);
          }
          }
        }
      }
    }
  } else {
    setActiveFocusArea('chat');
  }
});

onUnmounted(() => {
  Object.values(attachmentUrls.value).forEach(URL.revokeObjectURL);
});

function predictNextRole(index: number): 'user' | 'assistant' {
  if (editableMessages.value.length === 0) return 'user';
  
  // If there's a message before the insertion point, pick the opposite role
  if (index >= 0 && index < editableMessages.value.length) {
    const prevRole = editableMessages.value[index]!.role;
    switch (prevRole) {
    case 'user': return 'assistant';
    case 'assistant': return 'user';
    case 'system': return 'user'; // Fallback for system
    default: {
      const _ex: never = prevRole;
      return _ex;
    }
    }
  }
  
  // If inserting at the very beginning (index -1)
  if (index === -1 && editableMessages.value.length > 0) {
    const nextRole = editableMessages.value[0]!.role;
    switch (nextRole) {
    case 'user': return 'assistant';
    case 'assistant': return 'user';
    case 'system': return 'user'; // Fallback for system
    default: {
      const _ex: never = nextRole;
      return _ex;
    }
    }
  }

  return 'user';
}

function addMessage(index: number) {
  const role = predictNextRole(index);
  editableMessages.value.splice(index + 1, 0, {
    role,
    content: ''
  });
}

function removeMessage(index: number) {
  editableMessages.value.splice(index, 1);
}

function triggerFileInput(index: number) {
  fileInputs.value[index]?.click();
}

async function handleFileSelect(event: Event, index: number) {
  const target = event.target as HTMLInputElement;
  if (!target.files || !editableMessages.value[index]) return;

  const msg = editableMessages.value[index]!;
  if (!msg.attachments) msg.attachments = [];

  for (const file of Array.from(target.files)) {
    if (!file.type.startsWith('image/')) continue;
    
    const attachment: Attachment = {
      id: crypto.randomUUID(),
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: file,
    };
    msg.attachments.push(attachment);
    attachmentUrls.value[attachment.id] = URL.createObjectURL(file);
  }
  target.value = ''; // Reset input
}

async function handlePaste(event: ClipboardEvent, index: number) {
  const items = event.clipboardData?.items;
  if (!items || !editableMessages.value[index]) return;

  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  if (files.length > 0) {
    const msg = editableMessages.value[index]!;
    if (!msg.attachments) msg.attachments = [];

    for (const file of files) {
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        uploadedAt: Date.now(),
        status: 'memory',
        blob: file,
      };
      msg.attachments.push(attachment);
      attachmentUrls.value[attachment.id] = URL.createObjectURL(file);
    }
  }
}

function removeAttachment(msgIndex: number, attId: string) {
  const msg = editableMessages.value[msgIndex];
  if (msg && msg.attachments) {
    msg.attachments = msg.attachments.filter(a => a.id !== attId);
    if (attachmentUrls.value[attId]) {
      URL.revokeObjectURL(attachmentUrls.value[attId]!);
      delete attachmentUrls.value[attId];
    }
  }
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
        <div class="flex-1 overflow-y-auto p-6 space-y-8">
          <div v-if="editableMessages.length === 0" class="h-full flex flex-col items-center justify-center text-gray-400 gap-4">
            <Hammer class="w-12 h-12 opacity-20" />
            <p>No messages in history. Add one to start.</p>
            <button @click="addMessage(-1)" class="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all font-bold text-sm">
              <Plus class="w-4 h-4" />
              Add First Message
            </button>
          </div>
          
          <div v-for="(msg, index) in editableMessages" :key="index" class="relative group">
            <div class="flex gap-4 items-start">
              <!-- Role Selector -->
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
                <div class="text-[10px] font-bold uppercase tracking-tighter opacity-50" data-testid="role-label">{{ msg.role }}</div>
              </div>

              <!-- Content Area -->
              <div class="flex-1 bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-100 dark:border-gray-700 overflow-hidden focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all flex flex-col">
                <!-- Attachments -->
                <div v-if="msg.attachments && msg.attachments.length > 0" class="flex flex-wrap gap-2 px-4 pt-4">
                  <div v-for="att in msg.attachments" :key="att.id" class="relative group/att">
                    <img 
                      v-if="att.mimeType.startsWith('image/')"
                      :src="attachmentUrls[att.id]" 
                      class="w-16 h-16 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
                    />
                    <div v-else class="w-16 h-16 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded-lg">
                      <ImageIcon class="w-6 h-6 text-gray-400" />
                    </div>
                    <button 
                      @click="removeAttachment(index, att.id)"
                      class="absolute -top-2 -right-2 p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-sm opacity-0 group-hover/att:opacity-100 transition-opacity"
                    >
                      <X class="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <textarea 
                  v-model="msg.content"
                  @paste="handlePaste($event, index)"
                  class="w-full bg-transparent p-4 text-sm text-gray-800 dark:text-gray-100 focus:outline-none resize-none min-h-[100px]"
                  placeholder="Message content..."
                ></textarea>
                
                <!-- Bottom Bar -->
                <div class="px-4 py-2 bg-gray-100/30 dark:bg-gray-800/50 flex items-center justify-between border-t dark:border-gray-700">
                  <div class="flex gap-4 text-[10px] font-mono text-gray-500">
                    <span v-if="msg.modelId" class="flex items-center gap-1"><Cpu class="w-3 h-3" /> {{ msg.modelId }}</span>
                    <span v-if="msg.thinking" class="flex items-center gap-1 truncate"><History class="w-3 h-3" /> Has Thinking Content</span>
                  </div>
                  
                  <div class="flex items-center gap-2">
                    <input 
                      :ref="el => setFileInputRef(el, index)"
                      type="file" 
                      accept="image/*" 
                      multiple 
                      class="hidden" 
                      @change="handleFileSelect($event, index)"
                    />
                    <button 
                      @click="triggerFileInput(index)"
                      class="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-white dark:hover:bg-gray-700 transition-colors"
                      title="Attach images"
                    >
                      <Paperclip class="w-3.5 h-3.5" />
                    </button>
                  </div>
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
            <div v-if="index < editableMessages.length - 1" class="absolute left-[21px] top-[48px] bottom-[-32px] w-0.5 bg-gray-100 dark:bg-gray-800 -z-10"></div>
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
