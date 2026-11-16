<script setup lang="ts">
import { computed } from 'vue';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useSidebarNewChat } from '@/composables/useSidebarNewChat';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import ChatSidebarActionsView from './ChatSidebarActionsView.vue';

const props = defineProps<{ expanded: boolean, contentReady: boolean }>();
const emit = defineEmits<{ createChatGroup: [] }>();
const { currentChat, currentChatGroup } = useCurrentChatState();
const { createNewChat } = useChatLifecycle();
const { handleNewChat } = useSidebarNewChat({ currentChat, createNewChat });
const { openSearch } = useGlobalSearch();
const currentChatGroupId = computed(() => currentChatGroup.value?.id || currentChat.value?.groupId || undefined);
const groupContext = computed(() => currentChatGroupId.value === undefined ? undefined : { name: currentChatGroup.value?.name });

async function createInCurrentChatGroup(): Promise<void> {
  if (currentChatGroupId.value !== undefined) {
    await handleNewChat({ groupId: currentChatGroupId.value });
  }
}

function startChatGroupCreation(): void {
  if (props.contentReady) {
    emit('createChatGroup');
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <ChatSidebarActionsView :expanded="expanded" :content-ready="contentReady" interaction="ready" :group-context="groupContext" @new-chat="handleNewChat({ groupId: undefined })" @new-chat-in-group="createInCurrentChatGroup" @search="openSearch({})" @create-chat-group="startChatGroupCreation" />
</template>
