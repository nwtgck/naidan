import type { Endpoint } from './types';

/** Endpoint and model inheritance are independent, including empty model overrides. */
export function resolveChatModelBinding({ chat, chatGroup, settings }: {
  chat: { endpoint?: Endpoint, modelId?: string },
  chatGroup: { endpoint?: Endpoint, modelId?: string } | null | undefined,
  settings: { endpoint: Endpoint, defaultModelId?: string } | null,
}): {
  global: { endpoint: Endpoint, modelId: string },
  chatGroup: { endpoint: Endpoint, modelId: string },
  chat: { endpoint: Endpoint, modelId: string },
  sources: { endpoint: 'chat' | 'chat_group' | 'global', modelId: 'chat' | 'chat_group' | 'global' },
} {
  // A first chat can own a binding before global settings have ever been saved.
  // Resolve only its initial binding; do not create a persisted Settings record.
  const global: { endpoint: Endpoint, modelId: string } = settings === null
    ? { endpoint: { type: 'openai', url: '' }, modelId: '' }
    : { endpoint: settings.endpoint, modelId: settings.defaultModelId || '' };
  const groupPair = { endpoint: chatGroup?.endpoint ?? global.endpoint, modelId: chatGroup?.modelId || global.modelId };
  return {
    global,
    chatGroup: groupPair,
    chat: { endpoint: chat.endpoint ?? groupPair.endpoint, modelId: chat.modelId || groupPair.modelId },
    sources: {
      endpoint: chat.endpoint !== undefined ? 'chat' : (chatGroup?.endpoint !== undefined ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (chatGroup?.modelId ? 'chat_group' : 'global'),
    },
  };
}

export const TEST_ONLY = {
};
