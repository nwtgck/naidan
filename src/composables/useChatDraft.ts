import { reactive } from 'vue';
import type { Attachment } from '../models/types';

interface ChatDraft {
  input: string;
  attachments: Attachment[];
  attachmentUrls: Record<string, string>;
}

const drafts = reactive(new Map<string, ChatDraft>());

const globalDraft = reactive<ChatDraft>({
  input: '',
  attachments: [],
  attachmentUrls: {}
});

export function useChatDraft() {
  const getDraft = (chatId: string | undefined): ChatDraft => {
    if (!chatId) return globalDraft;

    if (!drafts.has(chatId)) {
      drafts.set(chatId, { input: '', attachments: [], attachmentUrls: {} });
    }
    return drafts.get(chatId)!;
  };

  const saveDraft = (chatId: string | undefined, draft: { input: string, attachments: Attachment[], attachmentUrls: Record<string, string> }) => {
    const d = getDraft(chatId);
    d.input = draft.input;
    d.attachments = [...draft.attachments];
    d.attachmentUrls = { ...draft.attachmentUrls };
  };

  const clearDraft = (chatId: string | undefined) => {
    const d = chatId ? drafts.get(chatId) : globalDraft;
    if (d) {
      // Note: We don't revoke here because the URLs might still be in use by the UI
      // during the transition or if clearDraft is called just before unmount.
      // But typically clearDraft is called after successful send, so revocation is safe.
      Object.values(d.attachmentUrls).forEach(url => URL.revokeObjectURL(url));
      d.input = '';
      d.attachments = [];
      d.attachmentUrls = {};
      if (chatId) drafts.delete(chatId);
    }
  };

  const revokeAll = () => {
    drafts.forEach(d => {
      Object.values(d.attachmentUrls).forEach(url => URL.revokeObjectURL(url));
      d.attachmentUrls = {};
    });
    Object.values(globalDraft.attachmentUrls).forEach(url => URL.revokeObjectURL(url));
    globalDraft.attachmentUrls = {};
  };

  const clearAllDrafts = () => {
    revokeAll();
    drafts.clear();
    globalDraft.input = '';
    globalDraft.attachments = [];
    globalDraft.attachmentUrls = {};
  };

  return {
    getDraft,
    saveDraft,
    clearDraft,
    clearAllDrafts,
    revokeAll,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
