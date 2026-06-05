<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import ChatPane from './ChatPane.vue';
import UnselectedChatPane from './UnselectedChatPane.vue';

const props = defineProps<{
  autoSendPrompt?: string;
  targetMessageId?: string;
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void;
}>();

const { currentChatId } = useCurrentChatState();
const chatPaneRef = ref<InstanceType<typeof ChatPane> | null>(null);

const inputVisibility = computed(() => chatPaneRef.value?.inputVisibility);
const container = computed(() => chatPaneRef.value?.container);

function scrollToBottom({
  scrollForce,
  behavior,
}: {
  scrollForce: 'force' | 'if-near-bottom';
  behavior: ScrollBehavior;
}) {
  return chatPaneRef.value?.scrollToBottom({ scrollForce, behavior });
}

function handleAutoSent(_args: Record<never, never>) {
  emit('auto-sent');
}

defineExpose({
  inputVisibility,
  container,
  scrollToBottom,
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <UnselectedChatPane v-if="!currentChatId" />
  <ChatPane
    v-else
    ref="chatPaneRef"
    :chat-id="currentChatId"
    :auto-send-prompt="props.autoSendPrompt"
    :target-message-id="props.targetMessageId"
    @auto-sent="handleAutoSent({})"
  />
</template>
