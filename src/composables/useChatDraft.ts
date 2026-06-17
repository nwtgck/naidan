import { reactive } from 'vue';
import type { AttachmentId, ChatId } from '@/models/ids';
import type { Attachment } from '@/models/types';

interface ChatDraft {
  input: string;
  attachments: Attachment[];
  attachmentUrls: Map<AttachmentId, string>;
}

const drafts = reactive(new Map<ChatId, ChatDraft>());

const globalDraft = reactive<ChatDraft>({
  input: '',
  attachments: [],
  attachmentUrls: new Map<AttachmentId, string>()
});

export function useChatDraft() {
  const getDraft = ({ chatId }: { chatId: ChatId | undefined }): ChatDraft => {
    if (!chatId) return globalDraft;

    if (!drafts.has(chatId)) {
      drafts.set(chatId, { input: '', attachments: [], attachmentUrls: new Map<AttachmentId, string>() });
    }
    return drafts.get(chatId)!;
  };

  const saveDraft = ({ chatId, draft }: { chatId: ChatId | undefined, draft: { input: string, attachments: Attachment[], attachmentUrls: Map<AttachmentId, string> } }) => {
    const d = getDraft({ chatId });
    d.input = draft.input;
    d.attachments = [...draft.attachments];
    d.attachmentUrls = new Map(draft.attachmentUrls);
  };

  const clearDraft = ({ chatId }: { chatId: ChatId | undefined }) => {
    const d = chatId ? drafts.get(chatId) : globalDraft;
    if (d) {
      // Note: We don't revoke here because the URLs might still be in use by the UI
      // during the transition or if clearDraft is called just before unmount.
      // But typically clearDraft is called after successful send, so revocation is safe.
      d.attachmentUrls.forEach(url => URL.revokeObjectURL(url));
      d.input = '';
      d.attachments = [];
      d.attachmentUrls = new Map<AttachmentId, string>();
      if (chatId) drafts.delete(chatId);
    }
  };

  const revokeAll = () => {
    drafts.forEach(d => {
      d.attachmentUrls.forEach(url => URL.revokeObjectURL(url));
      d.attachmentUrls = new Map<AttachmentId, string>();
    });
    globalDraft.attachmentUrls.forEach(url => URL.revokeObjectURL(url));
    globalDraft.attachmentUrls = new Map<AttachmentId, string>();
  };

  const clearAllDrafts = () => {
    revokeAll();
    drafts.clear();
    globalDraft.input = '';
    globalDraft.attachments = [];
    globalDraft.attachmentUrls = new Map<AttachmentId, string>();
  };

  return {
    getDraft,
    saveDraft,
    clearDraft,
    clearAllDrafts,
    revokeAll,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
