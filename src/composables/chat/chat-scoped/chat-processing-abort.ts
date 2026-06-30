import type { ChatId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import {
  chatRuntimeStore,
  contextCompactRuntime,
} from '@/composables/chat/global/chat-core-singletons';
import {
  abortTitleGenerationForChat,
} from '@/composables/chat/chat-scoped/chat-title-flow';

export function abortProcessingForChat({
  chatId,
}: {
  chatId: ChatId,
}): void {
  const activeGeneration = chatRuntimeStore.getActiveGeneration({ chatId });
  if (activeGeneration !== undefined) {
    activeGeneration.controller.abort();
    globalThis.setTimeout(() => {
      if (chatRuntimeStore.getActiveGeneration({ chatId }) === activeGeneration) {
        chatRuntimeStore.deleteActiveGeneration({ chatId });
      }
    }, 0);
  }

  const hasExternalGeneration = chatRuntimeStore.hasExternalGeneration({ chatId });
  if (activeGeneration !== undefined || hasExternalGeneration) {
    storageService.notify({
      event: {
        type: 'chat_content_generation',
        id: idToRaw({ id: chatId }),
        status: 'abort_request',
        timestamp: Date.now(),
      },
    });
  }

  contextCompactRuntime.getActiveContextCompaction({ chatId })?.abort();
  abortTitleGenerationForChat({ chatId });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
