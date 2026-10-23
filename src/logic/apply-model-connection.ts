import type { ChatId } from '@/01-models/ids';
import type { BrowserProvidedLmEndpoint, HttpEndpoint } from '@/01-models/types';
import { updateChatScopedSettings } from '@/composables/chat/global/chat-core-singletons';
import { useSettings } from '@/composables/useSettings';

/** The caller owns the dialog target and its captured storage lifetime. */
export async function applyModelConnectionSelection({ target, endpoint, modelId, isCurrent }: {
  target: { kind: 'home' } | { kind: 'chat', chatId: ChatId },
  endpoint: HttpEndpoint | BrowserProvidedLmEndpoint,
  modelId: string,
  isCurrent(): boolean,
}): Promise<void> {
  if (!isCurrent()) {
    throw new Error('The model connection selection is no longer current');
  }
  switch (target.kind) {
  case 'home': {
    const settings = useSettings();
    const outcome = await settings.commitGlobalModelConnection({ endpoint, modelId, isCurrent });
    switch (outcome) {
    case 'applied':
      if (!isCurrent()) {
        throw new Error('The model connection selection is no longer current');
      }
      // Confirmation authorizes the chosen connection even when the root URL
      // stays unchanged and ordinary navigation cannot release its refresh.
      settings.resumeModelRefresh();
      break;
    case 'changed': throw new Error('The model connection selection is no longer current');
    default: {
      const exhaustive: never = outcome;
      throw new Error(String(exhaustive));
    }
    }
    break;
  }
  case 'chat':
    await updateChatScopedSettings({
      chatId: target.chatId,
      changes: [
        { field: 'endpoint', behavior: 'override', value: endpoint },
        { field: 'model_id', behavior: 'override', value: modelId },
      ],
      isCurrent,
    });
    break;
  default: {
    const exhaustive: never = target;
    throw new Error(String(exhaustive));
  }
  }
  if (!isCurrent()) {
    throw new Error('The model connection selection is no longer current');
  }
}

export const TEST_ONLY = {
};
