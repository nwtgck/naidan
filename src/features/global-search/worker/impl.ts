import { idToRaw, toChatId } from '@/01-models/ids';
import type { ChatContent, StorageType } from '@/01-models/types';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';

import { searchChatTree, searchLinearBranch } from '@/features/global-search/logic/chat-search';
import { getChatBranchIterator } from '@/logic/chat-tree';
import type { ContentMatch as SearchContentMatch } from '@/features/global-search/logic/chat-search';
import {
  globalSearchWorkerSearchChatContentRequestSchema,
  type IGlobalSearchWorker,
} from './types';
import type { GlobalSearchRemoteContentReader } from './content-reader';

interface GlobalSearchContentReader {
  loadChatContentWithoutAttachments({
    chatId,
  }: {
    chatId: string,
  }): Promise<ChatContent | null>;
}

export function createGlobalSearchWorker(): IGlobalSearchWorker {
  let storageType: StorageType | undefined;
  let contentReader: GlobalSearchContentReader | undefined;

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the positional Comlink boundary declared by IGlobalSearchWorker.
    async configureStorage(nextStorageType, remoteContentReader) {
      const validatedStorageType = globalSearchWorkerSearchChatContentRequestSchema.shape.storageType.parse(
        nextStorageType,
      );

      switch (validatedStorageType) {
      case 'opfs': {
        if (remoteContentReader !== undefined) {
          throw new Error('Global Search OPFS storage must not receive a remote content reader');
        }
        const provider = new OPFSStorageProvider();
        await provider.init();
        contentReader = {
          loadChatContentWithoutAttachments({ chatId }) {
            return provider.loadChatContentWithoutAttachments({ id: toChatId({ raw: chatId }) });
          },
        };
        break;
      }
      case 'local':
      case 'memory':
        if (remoteContentReader === undefined) {
          throw new Error(`Global Search ${validatedStorageType} storage requires a remote content reader`);
        }
        contentReader = createRemoteContentReader({ remoteContentReader });
        break;
      default: {
        const _ex: never = validatedStorageType;
        throw new Error(`Unhandled Global Search storage type: ${String(_ex)}`);
      }
      }

      storageType = validatedStorageType;
    },

    async searchChatContent({ request }) {
      const validated = globalSearchWorkerSearchChatContentRequestSchema.parse(request);
      if (contentReader === undefined || storageType === undefined) {
        throw new Error('Global Search worker storage is not configured');
      }
      if (validated.storageType !== storageType) {
        throw new Error(
          `Global Search worker is configured for ${storageType} storage, received: ${validated.storageType}`,
        );
      }

      const content = await contentReader.loadChatContentWithoutAttachments({
        chatId: validated.chatId,
      });
      if (content === null) {
        return { matches: [] };
      }

      let matches: SearchContentMatch[] = [];

      switch (validated.scope) {
      case 'current_thread': {
        const branch = Array.from(getChatBranchIterator({ chat: content }));
        matches = searchLinearBranch({
          branch,
          query: validated.searchQuery,
          chatId: toChatId({ raw: validated.chatId }),
          targetLeafId: content.currentLeafId,
          roleFilter: validated.roleFilter,
        });
        break;
      }
      case 'all': {
        const activeNodes = Array.from(getChatBranchIterator({ chat: content }));
        const activeBranchIds = new Set(activeNodes.map(node => node.id));
        matches = searchChatTree({
          root: content.root,
          query: validated.searchQuery,
          chatId: toChatId({ raw: validated.chatId }),
          activeBranchIds,
          roleFilter: validated.roleFilter,
        });
        break;
      }
      case 'title_only':
        matches = [];
        break;
      default: {
        const _ex: never = validated.scope;
        throw new Error(`Unhandled search scope: ${_ex}`);
      }
      }

      const rawMatches = matches.map(match => ({
        ...match,
        chatId: idToRaw({ id: match.chatId }),
        messageId: idToRaw({ id: match.messageId }),
        targetLeafId: idToRaw({ id: match.targetLeafId }),
      }));

      return { matches: rawMatches };
    },
  };
}

function createRemoteContentReader({
  remoteContentReader,
}: {
  remoteContentReader: GlobalSearchRemoteContentReader,
}): GlobalSearchContentReader {
  return {
    async loadChatContentWithoutAttachments({ chatId }) {
      return remoteContentReader.loadChatContentWithoutAttachments({ chatId });
    },
  };
}
