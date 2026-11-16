import { useRouter } from 'vue-router';
import { idToRaw, type ChatGroupId } from '@/01-models/ids';
import type { ChatLifecycleAdapter } from '@/composables/chat/ui/useChatLifecycle';
import type { CurrentChatStateAdapter } from '@/composables/chat/ui/useCurrentChatState';
import { useDocumentMetadata } from './useDocumentMetadata';
import { useLayout } from './useLayout';

export function useSidebarNewChat({ currentChat, createNewChat }: { currentChat: CurrentChatStateAdapter['currentChat'], createNewChat: ChatLifecycleAdapter['createNewChat'] }) {
  const documentMetadata = useDocumentMetadata();
  const { setActiveFocusArea } = useLayout();
  const router = useRouter();

  async function handleNewChat({ groupId }: { groupId: ChatGroupId | undefined }): Promise<void> {
    documentMetadata?.finishHomeIntroduction();
    setActiveFocusArea({ area: 'chat' });
    await createNewChat({ groupId, modelId: undefined, systemPrompt: undefined });
    if (currentChat.value) {
      void router.push(`/chat/${idToRaw({ id: currentChat.value.id })}`);
    }
  }

  return { handleNewChat, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
