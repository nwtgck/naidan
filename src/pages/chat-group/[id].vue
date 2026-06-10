<script setup lang="ts">
import { watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useChatNavigation } from '@/composables/chat/ui/useChatNavigation';
import ChatGroupSettingsPanel from '@/components/ChatGroupSettingsPanel.vue';

const route = useRoute();
const chatNavigation = useChatNavigation();

interface RouteParams {
  id: string;
}

async function syncGroup() {
  const params = route.params as unknown as RouteParams;
  const id = params.id;
  if (id) {
    chatNavigation.openChatGroup({ groupId: id });
  }
}

onMounted(syncGroup);
watch(() => (route.params as unknown as RouteParams).id, syncGroup);


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-[#fcfcfd] dark:bg-gray-900 transition-colors">
    <ChatGroupSettingsPanel />
  </div>
</template>
