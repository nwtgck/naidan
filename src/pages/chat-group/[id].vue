<script setup lang="ts">
import { watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useChat } from '../../composables/useChat';
import GroupSettingsPanel from '../../components/GroupSettingsPanel.vue';

const route = useRoute();
const chatStore = useChat();

interface RouteParams {
  id: string;
}

async function syncGroup() {
  const params = route.params as unknown as RouteParams;
  const id = params.id;
  if (id) {
    chatStore.openChatGroup(id);
  }
}

onMounted(syncGroup);
watch(() => (route.params as unknown as RouteParams).id, syncGroup);
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-[#fcfcfd] dark:bg-gray-900 transition-colors">
    <GroupSettingsPanel />
  </div>
</template>
