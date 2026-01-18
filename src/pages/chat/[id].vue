<script setup lang="ts">
import { watch, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useChat } from '../../composables/useChat';
import ChatArea from '../../components/ChatArea.vue';

const router = useRouter();
const currentRoute = computed(() => router?.currentRoute?.value);
const { openChat } = useChat();

const chatId = computed(() => {
  const params = currentRoute.value?.params;
  // Use a type guard or check property existence to satisfy TS
  if (params && 'id' in params) {
    return params.id as string;
  }
  return undefined;
});

async function syncChat() {
  const id = chatId.value;
  if (id) {
    await openChat(id);
  }
}

function handleAutoSent() {
  const query = { ...currentRoute.value?.query };
  delete query.q;
  router.replace({ query });
}

onMounted(syncChat);
watch(chatId, syncChat);
</script>

<template>
  <transition
    name="fade"
    appear
  >
    <ChatArea 
      v-if="chatId"
      :key="chatId" 
      :auto-send-prompt="currentRoute?.query?.q?.toString()"
      @auto-sent="handleAutoSent"
    />
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
