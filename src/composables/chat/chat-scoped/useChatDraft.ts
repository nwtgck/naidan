import type { Ref } from 'vue';
import type { Attachment } from '@/models/types';
import { useChatDraft as useSharedChatDraft } from '@/composables/useChatDraft';

export type ChatDraftSnapshot = {
  input: string;
  attachments: Attachment[];
  attachmentUrls: Record<string, string>;
};

export type ChatDraftAdapter = {
  getDraft(_args: Record<never, never>): ChatDraftSnapshot;

  saveDraft({
    draft,
  }: {
    draft: ChatDraftSnapshot;
  }): void;

  clearDraft(_args: Record<never, never>): void;

  revokeAll(_args: Record<never, never>): void;
};

export function useChatDraft({
  chatId,
}: {
  chatId: Ref<string | undefined>;
}): ChatDraftAdapter {
  const draftStore = useSharedChatDraft();

  function getDraft(_args: Record<never, never>): ChatDraftSnapshot {
    return draftStore.getDraft({ chatId: chatId.value });
  }

  function saveDraft({
    draft,
  }: {
    draft: ChatDraftSnapshot;
  }) {
    draftStore.saveDraft({
      chatId: chatId.value,
      draft,
    });
  }

  function clearDraft(_args: Record<never, never>) {
    draftStore.clearDraft({ chatId: chatId.value });
  }

  function revokeAll(_args: Record<never, never>) {
    draftStore.revokeAll();
  }

  return {
    getDraft,
    saveDraft,
    clearDraft,
    revokeAll,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
