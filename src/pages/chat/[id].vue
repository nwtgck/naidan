<script setup lang="ts">
import { watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useChat } from '../../composables/useChat';
import ChatArea from '../../components/ChatArea.vue';

const route = useRoute('/chat/[id]');
const { openChat } = useChat();

async function syncChat() {
  const id = route.params.id;
  if (id) {
    await openChat(id as string);
  }
}

onMounted(syncChat);
watch(() => route.params.id, syncChat);
</script>

<template>
  <ChatArea />
</template>
