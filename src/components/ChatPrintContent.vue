<script setup lang="ts">
/**
 * ChatPrintContent provides a printer-friendly rendering of the current chat.
 * It uses the existing theme styles and colors.
 */
import { computed, onMounted } from 'vue';
import { useChat } from '../composables/useChat';
import { usePrint } from '../composables/usePrint';
import MessageItem from './MessageItem.vue';

const chatStore = useChat();
const { markPrintReady } = usePrint();
const { currentChat, activeMessages } = chatStore;
const chatTitle = computed(() => currentChat.value?.title || 'Chat History');

onMounted(() => {
  markPrintReady();
});


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- We add bg-inherit to ensure the background from PrintView (which has dark mode classes) is applied. -->
  <div v-if="currentChat" class="chat-print-content bg-inherit text-inherit">
    <header class="chat-print-header">
      <h1 class="text-3xl font-extrabold tracking-tight">{{ chatTitle }}</h1>
      <p v-if="currentChat.id" class="text-xs opacity-40 mt-2 tracking-widest uppercase">CHAT ID: {{ currentChat.id }}</p>
    </header>

    <div class="chat-print-messages">
      <MessageItem
        v-for="msg in activeMessages"
        :key="msg.id"
        :message="msg"
        :siblings="chatStore.getSiblings(msg.id)"
        class="chat-print-message-item"
      />
    </div>
  </div>
</template>

<style scoped>
.chat-print-content {
  /* We remove min-height here because PrintView handles full height.
     The parent background (gray-950) should flow behind everything. */
  padding: 0;
  margin: 0;
  width: 100%;
}

.chat-print-header {
  /* Increase top padding to avoid header text being too close to the edge of the paper */
  padding: 4rem 3rem 2rem 3rem;
  border-bottom: 2pt solid currentColor;
  opacity: 0.9;
}

.chat-print-message-item {
  break-inside: avoid !important;
  page-break-inside: avoid !important;
  display: block !important;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1) !important;
  padding-top: 2rem !important;
  padding-bottom: 2rem !important;
  padding-left: 3rem !important;
  padding-right: 3rem !important;
  margin: 0 !important;
  width: 100% !important;
  background: transparent !important; /* Let the parent's theme background flow through */
}

/* Ensure child MessageItem components don't show UI icons in print */
:deep(.group\/msg-header-tools),
:deep(.group\/msg-footer-tools),
:deep(button),
:deep(.message-version-paging) {
  display: none !important;
}
</style>
