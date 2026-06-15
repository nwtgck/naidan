<script setup lang="ts">
import type { MessageId } from '@/models/ids';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import ChatPane from './ChatPane.vue';
import UnselectedChatPane from './UnselectedChatPane.vue';

const props = defineProps<{
  autoSendPrompt?: string;
  targetMessageId?: MessageId;
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void;
}>();

const { currentChatId } = useCurrentChatState();

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <UnselectedChatPane v-if="!currentChatId" />
  <ChatPane
    v-else
    :chat-id="currentChatId"
    :auto-send-prompt="props.autoSendPrompt"
    :target-message-id="props.targetMessageId"
    @auto-sent="emit('auto-sent')"
  />
</template>
