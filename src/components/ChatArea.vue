<script setup lang="ts">
import ChatPane from './ChatPane.vue';

const props = defineProps<{
  autoSendPrompt?: string;
  targetMessageId?: string;
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void;
}>();

function handleAutoSent(_args: Record<never, never>) {
  emit('auto-sent');
}

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <ChatPane
    :auto-send-prompt="props.autoSendPrompt"
    :target-message-id="props.targetMessageId"
    @auto-sent="handleAutoSent({})"
  />
</template>
