import { storageService } from '@/services/storage';
import {
  chatRuntimeStore,
  contextCompactRuntime,
} from '@/composables/chat/global/chat-core-singletons';
import {
  abortTitleGenerationForChat,
} from '@/composables/chat/chat-scoped/chat-title-helpers';

export function abortProcessingForChat({
  chatId,
}: {
  chatId: string;
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
      type: 'chat_content_generation',
      id: chatId,
      status: 'abort_request',
      timestamp: Date.now(),
    });
  }

  contextCompactRuntime.getActiveContextCompaction({ chatId })?.abort();
  abortTitleGenerationForChat({ chatId });
}
