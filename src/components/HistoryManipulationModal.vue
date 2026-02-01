<script setup lang="ts">
import { ref, watch, onUnmounted, computed } from 'vue';
import draggable from 'vuedraggable';
import { 
  X, Save, Plus, Trash2, 
  User, Bot, Hammer, Cpu,
  Paperclip, Image as ImageIcon, History,
  Copy, GripVertical, MessageSquareQuote, Info
} from 'lucide-vue-next';
import { useChat } from '../composables/useChat';
import type { HistoryItem } from '../utils/chat-tree';
import { useLayout } from '../composables/useLayout';
import type { Attachment, SystemPrompt } from '../models/types';
import { storageService } from '../services/storage';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void
}>();

const chatStore = useChat();
const { currentChat, activeMessages, inheritedSettings } = chatStore;
const { setActiveFocusArea } = useLayout();

interface EditableHistoryItem extends HistoryItem {
  localId: string;
}

const editableMessages = ref<EditableHistoryItem[]>([]);
const attachmentUrls = ref<Record<string, string>>({});
const fileInputs = ref<(HTMLInputElement | null)[]>([]);
const isDragging = ref(false);

const localSystemPrompt = ref<SystemPrompt | undefined>(undefined);

function setFileInputRef(el: unknown, index: number) {
  fileInputs.value[index] = el as HTMLInputElement | null;
}

watch(() => props.isOpen, async (open) => {
  if (open && currentChat.value) {
    setActiveFocusArea('dialog');
    
    // Clear old URLs
    Object.values(attachmentUrls.value).forEach(URL.revokeObjectURL);
    attachmentUrls.value = {};

    // Clone system prompt setting
    localSystemPrompt.value = currentChat.value.systemPrompt ? JSON.parse(JSON.stringify(currentChat.value.systemPrompt)) : undefined;

    // Deep copy current branch to editable state with localIds
    editableMessages.value = activeMessages.value.map(m => ({
      localId: crypto.randomUUID(),
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
  
  if (index >= 0 && index < editableMessages.value.length) {
    const prevRole = editableMessages.value[index]!.role;
    switch (prevRole) {
    case 'user': return 'assistant';
    case 'assistant': return 'user';
    case 'system': return 'user';
    default: {
      const _ex: never = prevRole;
      return _ex;
    }
    }
  }
  
  if (index === -1 && editableMessages.value.length > 0) {
    const nextRole = editableMessages.value[0]!.role;
    switch (nextRole) {
    case 'user': return 'assistant';
    case 'assistant': return 'user';
    case 'system': return 'user';
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
    localId: crypto.randomUUID(),
    role,
    content: ''
  });
}

function removeMessage(index: number) {
  editableMessages.value.splice(index, 1);
}

function duplicateMessage(index: number) {
  const msg = editableMessages.value[index];
  if (!msg) return;
  
  editableMessages.value.splice(index + 1, 0, {
    ...msg,
    localId: crypto.randomUUID(),
    attachments: msg.attachments ? [...msg.attachments] : undefined
  });
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
  target.value = '';
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

const systemPromptBehavior = computed({
  get: () => {
    if (!localSystemPrompt.value) return 'inherit';
    if (localSystemPrompt.value.behavior === 'override' && localSystemPrompt.value.content === null) return 'clear';
    return localSystemPrompt.value.behavior;
  },
  set: (val: 'inherit' | 'clear' | 'override' | 'append') => {
    switch (val) {
    case 'inherit':
      localSystemPrompt.value = undefined;
      break;
    case 'clear':
      localSystemPrompt.value = { behavior: 'override', content: null };
      break;
    case 'override': {
      const content = (localSystemPrompt.value && localSystemPrompt.value.content !== null) ? localSystemPrompt.value.content : '';
      localSystemPrompt.value = { behavior: 'override', content };
      break;
    }
    case 'append': {
      const content = (localSystemPrompt.value && localSystemPrompt.value.content !== null) ? localSystemPrompt.value.content : '';
      localSystemPrompt.value = { behavior: 'append', content };
      break;
    }
    default: {
      const _ex: never = val;
      throw new Error(`Unhandled behavior: ${_ex}`);
    }
    }
  }
});

async function handleSave() {
  if (!currentChat.value) return;
  const cleanMessages: HistoryItem[] = editableMessages.value.map(({ localId: _, ...msg }) => msg);
  await chatStore.commitFullHistoryManipulation(currentChat.value.id, cleanMessages, localSystemPrompt.value);
  emit('close');
}

function handleCancel() {
  emit('close');
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
</script>

<template>
  <Transition name="modal">
    <div v-if="isOpen" class="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 md:p-6" @click.self="handleCancel">
      <div class="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl w-full max-w-5xl h-[90vh] flex flex-col border border-gray-100 dark:border-gray-800 modal-content-zoom overflow-hidden">
        
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-5 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-white dark:bg-gray-900 z-10">
          <div class="flex items-center gap-4">
            <div class="p-2.5 bg-orange-500/10 rounded-xl border border-orange-200 dark:border-orange-500/20">
              <Hammer class="w-5 h-5 text-orange-500" />
            </div>
            <div>
              <h2 class="text-base font-bold text-gray-800 dark:text-white tracking-tight">Super Edit</h2>
              <p class="text-[11px] text-gray-500 dark:text-gray-400 font-medium">Manipulate full chat history. A new branch will be created.</p>
            </div>
          </div>
          <button @click="handleCancel" class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto flex flex-col overscroll-contain bg-gray-50/30 dark:bg-black/10">
          
          <!-- Banner -->
          <div class="px-6 pt-6">
            <div class="flex items-center gap-3 px-4 py-3 bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100/50 dark:border-blue-900/20 rounded-2xl">
              <Info class="w-4 h-4 text-blue-500 shrink-0" />
              <p class="text-[11px] text-blue-700/70 dark:text-blue-300/70 font-medium leading-relaxed">
                Applying changes creates a <span class="font-bold text-blue-600 dark:text-blue-400">new branch</span> from the root. The original conversation remains preserved.
              </p>
            </div>
          </div>

          <!-- Chat System Prompt Section -->
          <div class="p-6">
            <div class="space-y-4">
              <div class="flex items-center justify-between px-1">
                <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest flex items-center gap-2">
                  <MessageSquareQuote class="w-3.5 h-3.5" />
                  Chat System Prompt
                </label>
              
                <div class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
                  <button 
                    v-for="b in (['inherit', 'clear', 'override', 'append'] as const)" 
                    :key="b"
                    @click="systemPromptBehavior = b"
                    class="px-2 py-0.5 text-[9px] font-bold rounded transition-all"
                    :class="systemPromptBehavior === b ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'"
                  >
                    {{ capitalize(b) }}
                  </button>
                </div>
              </div>

              <div v-if="systemPromptBehavior === 'override' || systemPromptBehavior === 'append'" class="animate-in fade-in slide-in-from-top-1 duration-200">
                <textarea 
                  v-model="localSystemPrompt!.content"
                  class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none min-h-[120px]"
                  placeholder="Enter system prompt content..."
                ></textarea>
              </div>
              
              <div v-else-if="systemPromptBehavior === 'clear'" class="w-full bg-gray-50 dark:bg-gray-800/50 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl px-4 py-8 text-center animate-in fade-in slide-in-from-top-1 duration-200">
                <p class="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest">Parent Prompt Cleared</p>
                <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-1">This chat will not use any system instructions.</p>
              </div>

              <div v-else class="p-4 bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-2xl space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                <div class="flex items-center justify-between text-[10px] font-bold">
                  <span class="text-gray-400 uppercase tracking-widest">System Prompt Resolution</span>
                  <span class="text-gray-300">Inherited</span>
                </div>
                <div class="pt-2 border-t border-gray-50 dark:border-gray-800/50">
                  <div class="text-xs text-gray-500 dark:text-gray-400 leading-relaxed italic font-medium">
                    {{ inheritedSettings?.systemPromptMessages.join('\n---\n') || 'No system prompt inherited.' }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Message List -->
          <div class="p-6 pt-0 space-y-6">
            <label class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
              <History class="w-3.5 h-3.5" />
              Message List
            </label>

            <div v-if="editableMessages.length === 0" class="p-16 bg-white dark:bg-gray-900 border border-dashed border-gray-200 dark:border-gray-700 rounded-2xl flex flex-col items-center justify-center text-gray-400 gap-5 shadow-sm">
              <div class="p-5 bg-orange-50 dark:bg-orange-900/20 rounded-full border border-orange-100 dark:border-orange-800">
                <Hammer class="w-8 h-8 text-orange-500 opacity-40" />
              </div>
              <p class="text-xs font-bold uppercase tracking-widest opacity-60">Forge empty history</p>
              <button @click="addMessage(-1)" class="flex items-center gap-2 px-8 py-3 bg-blue-600 text-white rounded-2xl hover:bg-blue-700 transition-all font-bold text-[11px] uppercase tracking-widest shadow-xl shadow-blue-500/20 active:scale-95">
                <Plus class="w-4 h-4" />
                Add First Message
              </button>
            </div>
          
            <draggable 
              v-model="editableMessages" 
              item-key="localId"
              handle=".handle"
              tag="div"
              :animation="250"
              :delay="200"
              :delay-on-touch-only="true"
              @start="isDragging = true"
              @end="isDragging = false"
              ghost-class="sortable-ghost"
              :class="['space-y-6', isDragging ? 'pb-40' : 'pb-8']"
              :scroll="true"
              :force-fallback="true"
              fallback-class="opacity-0"
            >
              <template #item="{ element: msg, index }">
                <div class="relative group">
                  <div class="flex gap-5 items-start">
                    <!-- Control Column -->
                    <div class="flex flex-col items-center gap-3 pt-3 shrink-0">
                      <div class="handle p-1.5 text-gray-300 dark:text-gray-700 cursor-grab active:cursor-grabbing hover:text-blue-500 transition-colors bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm">
                        <GripVertical class="w-3.5 h-3.5" />
                      </div>
                      
                      <button 
                        @click="msg.role = msg.role === 'user' ? 'assistant' : 'user'"
                        class="w-10 h-10 flex items-center justify-center rounded-xl transition-all shadow-sm border"
                        :class="{
                          'bg-blue-50 dark:bg-blue-900/20 text-blue-600 border-blue-100 dark:border-blue-800/50': msg.role === 'user',
                          'bg-purple-50 dark:bg-purple-900/20 text-purple-600 border-purple-100 dark:border-purple-800/50': msg.role === 'assistant'
                        }"
                        :title="'Switch Role'"
                      >
                        <User v-if="msg.role === 'user'" class="w-5 h-5" />
                        <Bot v-else class="w-5 h-5" />
                      </button>
                      <div class="text-[9px] font-bold text-gray-400 tracking-tight" data-testid="role-label">{{ capitalize(msg.role) }}</div>
                    </div>

                    <!-- Message Card -->
                    <div class="flex-1 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden focus-within:ring-4 focus-within:ring-blue-500/10 focus-within:border-blue-500 transition-all flex flex-col shadow-sm group-hover:shadow-md">
                      <!-- Attachments -->
                      <div v-if="msg.attachments && msg.attachments.length > 0" class="flex flex-wrap gap-2.5 px-5 pt-5 bg-gray-50/30 dark:bg-gray-800/20">
                        <div v-for="att in msg.attachments" :key="att.id" class="relative group/att pb-5">
                          <img 
                            v-if="att.mimeType.startsWith('image/')"
                            :src="attachmentUrls[att.id]" 
                            class="w-20 h-20 object-cover rounded-xl border-2 border-white dark:border-gray-800 shadow-sm"
                          />
                          <div v-else class="w-20 h-20 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                            <ImageIcon class="w-8 h-8 text-gray-400" />
                          </div>
                          <button 
                            @click="removeAttachment(index, att.id)"
                            class="absolute -top-2 -right-2 p-1.5 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-lg opacity-0 group-hover/att:opacity-100 transition-opacity"
                          >
                            <X class="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <textarea 
                        v-model="msg.content"
                        @paste="handlePaste($event, index)"
                        class="w-full bg-transparent p-4 text-[14px] text-gray-800 dark:text-gray-100 focus:outline-none resize-none min-h-[100px] font-medium leading-relaxed"
                        placeholder="Type message content..."
                      ></textarea>
                
                      <!-- Card Toolbar -->
                      <div class="px-4 py-1.5 bg-gray-50/50 dark:bg-gray-800/30 flex items-center justify-between border-t border-gray-50 dark:border-gray-800">
                        <div class="flex gap-4 text-[9px] font-bold font-mono text-gray-400/80 tracking-tight">
                          <span v-if="msg.modelId" class="flex items-center gap-1"><Cpu class="w-3 h-3" /> {{ msg.modelId }}</span>
                          <span v-if="msg.thinking" class="flex items-center gap-1"><History class="w-3 h-3" /> Thoughts</span>
                        </div>
                  
                        <div class="flex items-center gap-2">
                          <input 
                            :ref="el => setFileInputRef(el, index)"
                            type="file" accept="image/*" multiple class="hidden" 
                            @change="handleFileSelect($event, index)"
                          />
                          <button 
                            @click="triggerFileInput(index)"
                            class="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-white dark:hover:bg-gray-800 transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-700 shadow-sm"
                            title="Attach media"
                          >
                            <Paperclip class="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <!-- Side Action Column -->
                    <div class="flex flex-col gap-2 pt-3">
                      <button @click="removeMessage(index)" class="p-2.5 text-gray-400 hover:text-red-500 hover:bg-white dark:hover:bg-gray-800 rounded-xl transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-800 shadow-sm" title="Remove Message">
                        <Trash2 class="w-4.5 h-4.5" />
                      </button>
                      <button @click="duplicateMessage(index)" class="p-2.5 text-gray-400 hover:text-blue-500 hover:bg-white dark:hover:bg-gray-800 rounded-xl transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-800 shadow-sm" title="Copy Message">
                        <Copy class="w-4.5 h-4.5" />
                      </button>
                      <button @click="addMessage(index)" class="p-2.5 text-gray-400 hover:text-blue-500 hover:bg-white dark:hover:bg-gray-800 rounded-xl transition-all border border-transparent hover:border-gray-100 dark:hover:border-gray-800 shadow-sm" title="Add Message After">
                        <Plus class="w-4.5 h-4.5" />
                      </button>
                    </div>
                  </div>
            
                  <!-- Connector Line -->
                  <div v-if="index < editableMessages.length - 1" class="absolute left-[24.5px] top-[60px] bottom-[-32px] w-[2px] bg-gradient-to-b from-gray-200 via-gray-100 to-gray-200 dark:from-gray-700 dark:via-gray-800 dark:to-gray-700 -z-10 opacity-40"></div>
                </div>
              </template>
            </draggable>

            <div v-if="editableMessages.length > 0" class="flex justify-center pt-4 pb-8">
              <button 
                @click="addMessage(editableMessages.length - 1)" 
                class="flex items-center gap-2 px-6 py-2.5 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl text-gray-500 hover:text-blue-600 hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50/30 dark:hover:bg-blue-900/10 transition-all shadow-sm font-bold text-xs uppercase tracking-widest active:scale-95"
              >
                <Plus class="w-4 h-4" />
                Append Message
              </button>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-8 py-6 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end gap-5 bg-white dark:bg-gray-900 shrink-0">
          <button @click="handleCancel" class="px-6 py-2.5 text-[11px] font-bold text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors uppercase tracking-[0.15em]">
            Discard
          </button>
          <button 
            @click="handleSave" 
            :disabled="editableMessages.length === 0"
            class="flex items-center gap-2.5 px-10 py-3.5 bg-blue-600 text-white rounded-2xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-blue-500/25 font-bold text-[11px] uppercase tracking-[0.15em] active:scale-95"
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
  transition: opacity 0.3s ease;
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

.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slide-in-from-top {
  from { transform: translateY(-0.5rem); }
  to { transform: translateY(0); }
}
.fade-in {
  animation-name: fade-in;
}
.slide-in-from-top-1 {
  animation-name: slide-in-from-top;
}
</style>