import type { ChatContent, StorageType } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { toChatId } from '@/01-models/ids';

export interface GlobalSearchRemoteContentReader {
  loadChatContentWithoutAttachments({
    chatId,
  }: {
    chatId: string,
  }): Promise<ChatContent | null>;
}

export function createGlobalSearchRemoteContentReader({
  storageType,
}: {
  storageType: Extract<StorageType, 'local' | 'memory'>,
}): GlobalSearchRemoteContentReader {
  return {
    async loadChatContentWithoutAttachments({ chatId }) {
      const currentStorageType = storageService.getCurrentType();
      if (currentStorageType !== storageType) {
        throw new Error(
          `Global Search content reader expected ${storageType} storage, received: ${currentStorageType}`,
        );
      }

      return storageService.loadChatContentWithoutAttachments({
        id: toChatId({ raw: chatId }),
      });
    },
  };
}
