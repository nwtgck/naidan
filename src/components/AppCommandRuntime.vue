<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatListData } from '@/composables/chat/ui/useChatListData';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import {
  isAppInteractionEnabled,
  useAppPresentation,
} from '@/composables/useAppPresentation';
import { useGlobalSearch } from '@/composables/useGlobalSearch';
import { useLayout } from '@/composables/useLayout';
import { useRecentChats } from '@/composables/useRecentChats';
import { useSettings } from '@/composables/useSettings';
import { idToRaw, toChatId, type ChatGroupId } from '@/models/ids';

const currentChatState = useCurrentChatState();
const chatLifecycle = useChatLifecycle();
const chatListData = useChatListData();
const chatOrganization = useChatOrganization();
const settingsStore = useSettings();
const { appInteraction } = useAppPresentation();
const { addRecentChat, toggleRecent } = useRecentChats();
const router = useRouter();
const route = useRoute();

watch(
  () => route.path,
  () => {
    if (!isAppInteractionEnabled({ interaction: appInteraction.value })) return;
    if (route.name === '/chat/[id]' && route.params.id && typeof route.params.id === 'string') {
      addRecentChat({ id: toChatId({ raw: route.params.id }) });
    }
  },
  { immediate: true },
);

watch(
  [
    () => chatListData.chats.value.length,
    () => router.currentRoute.value?.path,
    () => router.currentRoute.value?.query?.q,
    () => router.currentRoute.value?.query?.['chat-group'],
    () => router.currentRoute.value?.query?.model,
    () => router.currentRoute.value?.query?.['system-prompt'] || router.currentRoute.value?.query?.sp,
    () => settingsStore.initialized.value,
    () => settingsStore.isOnboardingDismissed.value,
  ],
  async ([len, path, q, chatGroupId, modelId, systemPromptStr, initialized, dismissed]) => {
    if (
      !isAppInteractionEnabled({ interaction: appInteraction.value })
      || !initialized
      || !dismissed
      || path !== '/'
    ) return;

    if (len === 0 && !q) {
      const { setActiveFocusArea } = useLayout();
      setActiveFocusArea({ area: 'chat' });
      await chatLifecycle.createNewChat({
        groupId: undefined,
        modelId: undefined,
        systemPrompt: undefined,
      });
      if (!isAppInteractionEnabled({ interaction: appInteraction.value })) return;
      if (currentChatState.currentChat.value) {
        await router.push(`/chat/${idToRaw({ id: currentChatState.currentChat.value.id })}`);
      }
      return;
    }

    if (!q) return;

    let targetGroupId: ChatGroupId | undefined = undefined;
    if (typeof chatGroupId === 'string') {
      const group = currentChatState.chatGroups.value.find(candidate =>
        idToRaw({ id: candidate.id }) === chatGroupId || candidate.name === chatGroupId,
      );
      if (group) {
        targetGroupId = group.id;
      } else {
        targetGroupId = await chatOrganization.createChatGroup({
          name: chatGroupId,
          options: undefined,
        });
      }
    }

    if (!isAppInteractionEnabled({ interaction: appInteraction.value })) return;
    const targetModelId = typeof modelId === 'string' ? modelId : undefined;
    const systemPrompt = typeof systemPromptStr === 'string' && systemPromptStr
      ? {
        behavior: 'override' as const,
        content: systemPromptStr,
      }
      : undefined;

    const { setActiveFocusArea } = useLayout();
    setActiveFocusArea({ area: 'chat' });
    await chatLifecycle.createNewChat({
      groupId: targetGroupId,
      modelId: targetModelId,
      systemPrompt,
    });

    if (currentChatState.currentChat.value && isAppInteractionEnabled({ interaction: appInteraction.value })) {
      await router.push({
        path: `/chat/${idToRaw({ id: currentChatState.currentChat.value.id })}`,
        query: { q: q.toString() },
      });
    }
  },
  { immediate: true },
);

onKeyStroke(['o', 'O', 'k', 'K', 'p', 'P'], async (event) => {
  if (!isAppInteractionEnabled({ interaction: appInteraction.value })) return;

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'o' || event.key === 'O')) {
    event.preventDefault();
    const { setActiveFocusArea } = useLayout();
    setActiveFocusArea({ area: 'chat' });
    await chatLifecycle.createNewChat({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined,
    });
    if (currentChatState.currentChat.value && isAppInteractionEnabled({ interaction: appInteraction.value })) {
      await router.push(`/chat/${idToRaw({ id: currentChatState.currentChat.value.id })}`);
    }
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    if (isMac && !event.metaKey) return;
    event.preventDefault();
    useGlobalSearch().toggleSearch();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'p' || event.key === 'P')) {
    event.preventDefault();
    toggleRecent();
  }
});


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
