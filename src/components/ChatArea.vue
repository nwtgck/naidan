<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../composables/useChat';
import { useSettings } from '../composables/useSettings';
import MessageItem from './MessageItem.vue';
import ChatSettingsPanel from './ChatSettingsPanel.vue';
import WelcomeScreen from './WelcomeScreen.vue';
import { 
  ArrowUp, Download, Settings2, MoreVertical, Bug, 
  Square, Loader2, Minimize2, Maximize2, Send,
  Paperclip, X, GitFork,
} from 'lucide-vue-next';
import { v7 as uuidv7 } from 'uuid';
import type { Attachment } from '../models/types';


const chatStore = useChat();
const {
  currentChat,
  streaming,
  activeMessages,
  availableModels,
  fetchingModels,
} = chatStore;
const { settings } = useSettings();
const router = useRouter();
const input = ref('');
const container = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isMaximized = ref(false); // New state for maximize button
const isOverLimit = ref(false); // New state to show maximize button only when content is long

const attachments = ref<Attachment[]>([]);
const attachmentUrls = ref<Record<string, string>>({});
const isDragging = ref(false);

watch(attachments, (newAtts) => {
  // Revoke URLs for removed attachments
  Object.keys(attachmentUrls.value).forEach(id => {
    if (!newAtts.find(a => a.id === id)) {
      const url = attachmentUrls.value[id];
      if (url) {
        URL.revokeObjectURL(url);
      }
      delete attachmentUrls.value[id];
    }
  });

  // Create URLs for new attachments
  newAtts.forEach(att => {
    if (att.status === 'memory' && !attachmentUrls.value[att.id]) {
      attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
    }
  });
}, { deep: true });

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

const showChatSettings = ref(false);
const showMoreMenu = ref(false);

function triggerFileInput() {
  fileInputRef.value?.click();
}

async function processFiles(files: File[]) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    
    const attachment: Attachment = {
      id: uuidv7(),
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: file,
    };
    attachments.value.push(attachment);
  }
  nextTick(adjustTextareaHeight);
}

async function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files) return;

  await processFiles(Array.from(target.files));
  target.value = ''; // Reset input
}

function handleDragOver(event: DragEvent) {
  event.preventDefault();
  isDragging.value = true;
}

function handleDragLeave(event: DragEvent) {
  // Only set to false if we are leaving the main container
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (
    event.clientX <= rect.left ||
    event.clientX >= rect.right ||
    event.clientY <= rect.top ||
    event.clientY >= rect.bottom
  ) {
    isDragging.value = false;
  }
}

async function handleDrop(event: DragEvent) {
  event.preventDefault();
  isDragging.value = false;
  
  if (event.dataTransfer?.files) {
    await processFiles(Array.from(event.dataTransfer.files));
  }
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id);
  nextTick(adjustTextareaHeight);
}

function applySuggestion(text: string) {
  input.value = text;
  nextTick(() => {
    adjustTextareaHeight();
    focusInput();
  });
}

function adjustTextareaHeight() {
  if (textareaRef.value) {
    const target = textareaRef.value;
    
    if (isMaximized.value) {
      // Set a fixed max height on the parent container instead of just the textarea
      // The parent already has flex-col, so textarea will take available space
      target.style.height = 'auto'; // Reset for measurement
      const maxHeightVh = window.innerHeight * 0.7;
      target.style.height = maxHeightVh + 'px';
      target.style.overflowY = target.scrollHeight > maxHeightVh ? 'auto' : 'hidden';
      return;
    }

    // Temporarily reset height to auto to measure content height
    target.style.height = 'auto';
    const currentScrollHeight = target.scrollHeight;
    
    const computedStyle = getComputedStyle(target);
    const lineHeight = parseFloat(computedStyle.lineHeight);
    const paddingTop = parseFloat(computedStyle.paddingTop);
    const paddingBottom = parseFloat(computedStyle.paddingBottom);
    const borderTop = parseFloat(computedStyle.borderTopWidth);
    const borderBottom = parseFloat(computedStyle.borderBottomWidth);
    const verticalPadding = paddingTop + paddingBottom + borderTop + borderBottom;
    
    // Minimum 1 line, Maximum 6 lines
    const minHeight = lineHeight + verticalPadding;
    const maxSixLinesHeight = (lineHeight * 6) + verticalPadding;

    isOverLimit.value = currentScrollHeight > maxSixLinesHeight;

    const finalHeight = Math.max(minHeight, Math.min(currentScrollHeight, maxSixLinesHeight));
    target.style.height = finalHeight + 'px';
    target.style.overflowY = currentScrollHeight > maxSixLinesHeight ? 'auto' : 'hidden';

    if (container.value) {
      const { scrollTop, scrollHeight, clientHeight } = container.value;
      if (scrollHeight - scrollTop - clientHeight < 50) {
        nextTick(scrollToBottom);
      }
    }
  }
}

function toggleMaximized() {
  isMaximized.value = !isMaximized.value;
  nextTick(() => {
    adjustTextareaHeight();
    scrollToBottom(); // Re-scroll to bottom after resizing
  });
}

function exportChat() {
  if (!currentChat.value || !activeMessages.value) return;

  let markdownContent = `# ${currentChat.value.title || 'Untitled Chat'}\n\n`;

  activeMessages.value.forEach(msg => {
    const role = msg.role === 'user' ? 'User' : 'AI';
    markdownContent += `## ${role}:\n${msg.content}\n\n`;
  });

  const blob = new Blob([markdownContent], { type: 'text/plain;charset=utf-8' });
  const filename = `${currentChat.value.title || 'untitled_chat'}.txt`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function focusInput() {
  nextTick(() => {
    textareaRef.value?.focus();
  });
}

function scrollToBottom() {
  if (container.value) {
    container.value.scrollTop = container.value.scrollHeight;
  }
}

// Expose for testing
defineExpose({ scrollToBottom, container, handleSend, isMaximized, adjustTextareaHeight, attachments, input });

async function fetchModels() {
  await chatStore.fetchAvailableModels();
}

async function handleSend() {
  if ((!input.value.trim() && attachments.value.length === 0) || streaming.value) return;
  const text = input.value;
  const currentAttachments = [...attachments.value];
  
  input.value = '';
  attachments.value = [];
  isMaximized.value = false; // Reset maximized state immediately upon sending
  
  nextTick(() => { // Ensure textarea is cleared before adjusting height
    adjustTextareaHeight();
  });
  
  await chatStore.sendMessage(text, undefined, currentAttachments);
  focusInput();
}

async function handleEdit(messageId: string, newContent: string) {
  await chatStore.editMessage(messageId, newContent);
}

function handleSwitchVersion(messageId: string) {
  chatStore.switchVersion(messageId);
}

async function handleFork(messageId: string) {
  const newId = await chatStore.forkChat(messageId);
  if (newId) {
    router.push(`/chat/${newId}`);
  }
}

function handleForkLastMessage() {
  const lastMsg = activeMessages.value[activeMessages.value.length - 1];
  if (lastMsg) {
    handleFork(lastMsg.id);
  }
}

function jumpToOrigin() {
  if (currentChat.value?.originChatId) {
    router.push(`/chat/${currentChat.value.originChatId}`);
  }
}

watch(
  () => activeMessages.value.length,
  () => nextTick(scrollToBottom),
);

watch(
  () => activeMessages.value[activeMessages.value.length - 1]?.content,
  (newContent) => {
    if (streaming.value && newContent && newContent.length < 400 && container.value) {
      const { scrollTop, scrollHeight, clientHeight } = container.value;
      // Only auto-scroll if user is already at the bottom (within 50px)
      if (scrollHeight - scrollTop - clientHeight < 50) {
        nextTick(scrollToBottom);
      }
    }
  },
  { deep: true },
);

watch(input, () => {
  adjustTextareaHeight();
}, { flush: 'post' }); // Ensure DOM is updated before recalculating

watch(isMaximized, () => {
  nextTick(() => {
    adjustTextareaHeight();
    scrollToBottom();
  });
});

watch(
  () => currentChat.value?.id,
  () => {
    if (currentChat.value) {
      isMaximized.value = false;
      fetchModels();
      nextTick(() => {
        scrollToBottom();
        focusInput();
        adjustTextareaHeight();
      });
    }
  },
);

onMounted(() => {
  window.addEventListener('resize', adjustTextareaHeight);
  if (currentChat.value) {
    fetchModels();
  }
  nextTick(() => {
    scrollToBottom();
    adjustTextareaHeight(); // Call adjustTextareaHeight on mount
    if (currentChat.value) {
      focusInput();
    }
  });
});

import { onUnmounted } from 'vue';
onUnmounted(() => {
  window.removeEventListener('resize', adjustTextareaHeight);
  // Revoke all created URLs
  Object.values(attachmentUrls.value).forEach(url => URL.revokeObjectURL(url));
});
</script>

<template>
  <div 
    class="flex flex-col h-full bg-[#fcfcfd] dark:bg-gray-900 transition-colors relative"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Drag Overlay -->
    <div 
      v-if="isDragging"
      class="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 pointer-events-none flex items-center justify-center"
      data-testid="drag-overlay"
    >
      <div class="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-xl flex items-center gap-3 animate-in zoom-in duration-200">
        <Paperclip class="w-6 h-6 text-blue-500" />
        <span class="text-lg font-bold text-gray-800 dark:text-gray-100">Drop images to attach</span>
      </div>
    </div>

    <!-- Header -->
    <div class="border-b border-gray-100 dark:border-gray-800 px-4 sm:px-6 py-3 flex items-center justify-between bg-white/80 dark:bg-gray-900/80 backdrop-blur-md shadow-sm z-20">
      <div class="flex items-center gap-3 overflow-hidden min-h-[44px]">
        <div class="flex flex-col overflow-hidden">
          <template v-if="currentChat">
            <div class="flex items-center gap-2">
              <button 
                v-if="currentChat.originChatId"
                @click="jumpToOrigin"
                class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600 transition-colors"
                title="Jump to original chat"
                data-testid="jump-to-origin-button"
              >
                <ArrowUp class="w-4 h-4" />
              </button>
              <h2 class="text-base sm:text-lg font-bold text-gray-800 dark:text-gray-100 tracking-tight truncate">{{ currentChat.title || 'Untitled Chat' }}</h2>
            </div>
            
            <!-- Model Badge/Trigger -->
            <button 
              @click="showChatSettings = !showChatSettings"
              class="flex items-center gap-1.5 w-fit group"
              title="Chat Settings & Model Override"
              data-testid="model-trigger"
            >
              <div 
                class="px-2 py-0.5 rounded-full text-[10px] font-bold transition-all flex items-center gap-1.5"
                :class="showChatSettings 
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' 
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 group-hover:bg-gray-200 dark:group-hover:bg-gray-700 group-hover:text-gray-700 dark:group-hover:text-gray-200'"
              >
                <span class="truncate max-w-[120px] sm:max-w-[200px]">
                  {{ currentChat.overrideModelId || settings.defaultModelId || 'Default Model' }}
                </span>
                <Settings2 class="w-3 h-3" :class="{ 'animate-pulse': showChatSettings }" />
              </div>
              <div 
                v-if="currentChat.endpointUrl || currentChat.endpointType || currentChat.overrideModelId || currentChat.systemPrompt || (currentChat.lmParameters && Object.keys(currentChat.lmParameters).length > 0)" 
                class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" 
                title="Custom overrides active"
                data-testid="custom-overrides-indicator"
              ></div>
            </button>
          </template>
          <template v-else>
            <!-- Header empty when no chat is selected -->
          </template>
        </div>
      </div>

      <div class="flex items-center gap-1 relative">
        <div v-if="currentChat" class="flex items-center gap-1">
          <button 
            v-if="activeMessages.length > 0"
            @click="handleForkLastMessage"
            class="p-2 rounded-xl transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            title="Fork Chat from last message"
            data-testid="fork-chat-button"
          >
            <GitFork class="w-5 h-5" />
          </button>

          <button 
            @click="exportChat"
            class="p-2 rounded-xl transition-colors text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            title="Export Chat"
          >
            <Download class="w-5 h-5" />
          </button>

          <button 
            @click="showMoreMenu = !showMoreMenu"
            class="p-2 rounded-xl text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            title="More Actions"
            data-testid="more-actions-button"
          >
            <MoreVertical class="w-5 h-5" />
          </button>
        </div>

        <!-- Kebab Menu Dropdown -->
        <div 
          v-if="showMoreMenu" 
          class="absolute right-0 top-full mt-2 w-56 bg-white/95 dark:bg-gray-800/95 backdrop-blur-md border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 animate-in fade-in zoom-in duration-200"
          @mouseleave="showMoreMenu = false"
        >
          <button 
            @click="chatStore.toggleDebug(); showMoreMenu = false"
            class="w-full flex items-center gap-3 px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider transition-colors"
            :class="currentChat?.debugEnabled 
              ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' 
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600'
            "
          >
            <Bug class="w-4 h-4" />
            <span>Debug Mode</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Chat Settings Panel -->
    <ChatSettingsPanel 
      v-if="showChatSettings" 
      @close="showChatSettings = false" 
    />

    <!-- Messages -->
    <div class="flex-1 flex overflow-hidden">
      <div ref="container" data-testid="scroll-container" class="flex-1 overflow-y-auto relative">
        <div v-if="!currentChat" class="h-full flex items-center justify-center text-gray-400 dark:text-gray-500">
          Select or create a chat to start
        </div>
        <template v-else>
          <div v-if="activeMessages.length > 0" class="relative p-2">
            <MessageItem 
              v-for="msg in activeMessages" 
              :key="msg.id" 
              :message="msg" 
              :siblings="chatStore.getSiblings(msg.id)"
              @fork="handleFork"
              @edit="handleEdit"
              @switch-version="handleSwitchVersion"
              class="animate-in fade-in duration-300"
            />
          </div>
          <WelcomeScreen 
            v-else 
            @select-suggestion="applySuggestion" 
          />
        </template>
      </div>

      <!-- Chat State Inspector (Debug Mode) -->
      <div 
        v-if="currentChat?.debugEnabled" 
        class="w-96 border-l dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-y-auto p-4 font-mono text-[10px] animate-in slide-in-from-right duration-300 shadow-xl z-20"
        data-testid="chat-inspector"
      >
        <div class="flex items-center justify-between mb-4 pb-2 border-b dark:border-gray-800">
          <div class="flex items-center gap-2 text-indigo-500 uppercase font-bold tracking-widest">
            <Bug class="w-3.5 h-3.5" />
            <span>Chat Inspector</span>
          </div>
          <button @click="chatStore.toggleDebug" class="text-gray-400 hover:text-white">
            <Square class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="space-y-4">
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Metadata</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ JSON.stringify({ id: currentChat.id, title: currentChat.title, model: currentChat.modelId, currentLeafId: currentChat.currentLeafId }, null, 2) }}</pre>
          </section>
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Active Branch Path</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ activeMessages.map(m => `[${m.role.slice(0,1).toUpperCase()}] ${m.id.slice(0,8)}...`).join(' -> ') }}</pre>
          </section>
          <section>
            <h3 class="text-gray-500 mb-1 font-bold">Full Tree Structure</h3>
            <pre class="bg-black/10 dark:bg-black/30 p-2 rounded border dark:border-gray-800">{{ JSON.stringify(currentChat.root.items, null, 2) }}</pre>
          </section>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="border-t border-gray-100 dark:border-gray-800 p-6 bg-white dark:bg-gray-900" v-if="currentChat">
      <div class="max-w-4xl mx-auto relative group border border-gray-100 dark:border-gray-700 rounded-2xl bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-colors duration-200 shadow-sm group-hover:shadow-md flex flex-col">
        
        <!-- Attachment Previews -->
        <div v-if="attachments.length > 0" class="flex flex-wrap gap-2 px-4 pt-4" data-testid="attachment-preview">
          <div v-for="att in attachments" :key="att.id" class="relative group/att">
            <img 
              :src="attachmentUrls[att.id]" 
              class="w-20 h-20 object-cover rounded-lg border border-gray-200 dark:border-gray-700"
            />
            <button 
              @click="removeAttachment(att.id)"
              class="absolute -top-2 -right-2 p-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-full text-gray-400 hover:text-red-500 shadow-sm opacity-0 group-hover/att:opacity-100 transition-opacity"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        </div>

        <textarea
          ref="textareaRef"
          v-model="input"
          @input="adjustTextareaHeight"
          @keydown.enter.ctrl.prevent="handleSend"
          @keydown.enter.meta.prevent="handleSend"
          @keydown.esc.prevent="streaming ? chatStore.abortChat() : null"
          placeholder="Type a message..."
          class="w-full text-base pl-5 pr-12 pt-4 pb-2 focus:outline-none bg-transparent text-gray-800 dark:text-gray-100 resize-none min-h-[60px] transition-colors"
          data-testid="chat-input"
        ></textarea>
        <!-- Maximize/Minimize Button inside input area -->
        <button
          v-if="isOverLimit || isMaximized"
          @click="toggleMaximized"
          class="absolute right-4 top-4 p-1.5 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors z-20 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm shadow-sm border border-gray-100 dark:border-gray-700"
          :title="isMaximized ? 'Minimize Input' : 'Maximize Input'"
          data-testid="maximize-button"
        >
          <Minimize2 v-if="isMaximized" class="w-4 h-4" />
          <Maximize2 v-else class="w-4 h-4" />
        </button>
        <div class="flex items-center justify-between px-4 pb-4">
          <div class="flex items-center gap-2">
            <input 
              ref="fileInputRef"
              type="file" 
              accept="image/*" 
              multiple 
              class="hidden" 
              @change="handleFileSelect"
            />
            <button 
              @click="triggerFileInput"
              class="p-2 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              title="Attach images"
            >
              <Paperclip class="w-5 h-5" />
            </button>

            <div class="relative flex items-center">
              <select 
                v-model="currentChat.overrideModelId"
                class="text-xs font-bold border border-gray-100 dark:border-gray-700 rounded-xl pl-3 pr-9 py-2.5 bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 appearance-none max-w-[100px] sm:max-w-[180px] truncate cursor-pointer shadow-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-all"
                title="Override Model"
                data-testid="model-override-select"
              >
                <option :value="undefined">{{ settings.defaultModelId || 'Default Model' }}</option>
                <option v-for="m in availableModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <Loader2 v-if="fetchingModels" class="w-3.5 h-3.5 animate-spin absolute right-3 pointer-events-none text-gray-400" />
              <Settings2 v-else class="w-3.5 h-3.5 absolute right-3 pointer-events-none text-gray-400" />
            </div>
          </div>

          <button 
            @click="streaming ? chatStore.abortChat() : handleSend()"
            :disabled="!streaming && !input.trim() && attachments.length === 0"
            class="px-4 py-2.5 text-white bg-blue-600 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-all shadow-lg shadow-blue-500/30 whitespace-nowrap"
            :title="streaming ? 'Stop generating (Esc)' : 'Send message (' + sendShortcutText + ')'"
            :data-testid="streaming ? 'abort-button' : 'send-button'"
          >
            <template v-if="streaming">
              <span class="text-xs font-medium opacity-90 hidden sm:inline">Esc</span>
              <Square class="w-4 h-4 fill-white text-white" />
            </template>
            <template v-else>
              <span class="text-[10px] font-bold opacity-90 hidden sm:inline tracking-wider">{{ sendShortcutText }}</span>
              <Send class="w-4 h-4" />
            </template>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Simplified animations */
.animate-in {
  animation-fill-mode: forwards;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes zoom-in {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}
.fade-in {
  animation-name: fade-in;
}
.zoom-in {
  animation-name: zoom-in;
}
</style>
