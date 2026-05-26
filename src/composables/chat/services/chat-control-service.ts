import { toRaw, type Ref } from 'vue';
import type { Chat } from '@/models/types';

export type ChatControlService = {
  abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }): void;

  compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<boolean>;
};

export function createChatControlService({
  currentChatRef,
  abortContextCompact,
  hasActiveGeneration,
  abortActiveGeneration,
  hasExternalGeneration,
  notifyAbortRequest,
  abortTitleGeneration,
  compactCurrentBranchImpl,
}: {
  currentChatRef: Ref<Chat | null>;
  abortContextCompact: ({ chatId }: { chatId: string }) => void;
  hasActiveGeneration: ({ chatId }: { chatId: string }) => boolean;
  abortActiveGeneration: ({ chatId }: { chatId: string }) => void;
  hasExternalGeneration: ({ chatId }: { chatId: string }) => boolean;
  notifyAbortRequest: ({ chatId }: { chatId: string }) => void;
  abortTitleGeneration: ({ chatId }: { chatId: string | undefined }) => void;
  compactCurrentBranchImpl: ({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }) => Promise<{ status: 'compacted' | 'unchanged' | 'aborted' | 'failed' | 'skipped' }>;
}): ChatControlService {
  function abortChat({
    chatId,
  }: {
    chatId: string | undefined;
  }) {
    const id = chatId || (currentChatRef.value ? toRaw(currentChatRef.value).id : null);
    if (!id) return;

    abortContextCompact({ chatId: id });
    if (hasActiveGeneration({ chatId: id })) {
      abortActiveGeneration({ chatId: id });
      notifyAbortRequest({ chatId: id });
    } else if (hasExternalGeneration({ chatId: id })) {
      notifyAbortRequest({ chatId: id });
    }
    abortTitleGeneration({ chatId: id });
  }

  async function compactCurrentBranch({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }) {
    const result = await compactCurrentBranchImpl({
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  }

  return {
    abortChat,
    compactCurrentBranch,
  };
}
