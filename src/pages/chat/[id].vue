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
  <transition
    name="fade"
    appear
  >
    <ChatArea :key="route.params.id as string" />
  </transition>
</template>

<style scoped>
.fade-enter-active {
  transition: opacity 0.15s ease-out, transform 0.15s ease-out;
}

.fade-enter-from {
  opacity: 0;
  transform: translateY(2px);
}

/* We don't use leave-active to keep navigation instant */
</style>
