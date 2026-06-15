import type { EndpointType } from '@/models/types';
import type { ChatId } from '@/models/ids';
import {
  fetchModelsForChat,
  fetchModelsForEndpoint,
  fetchModelsForGlobalEndpoint,
} from '@/composables/chat/chat-model-fetch';
export {
  resolveChatEndpointForChat,
  resolveGlobalEndpoint,
} from '@/composables/chat/chat-model-helpers';

// Compatibility wrapper for legacy chat-scoped flow imports.
// Keep model-fetch behavior in chat-model-fetch.ts.

export async function fetchAvailableModelsForChat({
  chatId,
  errorSource,
}: {
  chatId: ChatId;
  errorSource: string;
}): Promise<string[]> {
  return await fetchModelsForChat({
    chatId,
    errorSource,
  });
}

export async function fetchAvailableModelsForGlobalEndpoint({
  errorSource,
}: {
  errorSource: string;
}): Promise<string[]> {
  return await fetchModelsForGlobalEndpoint({
    errorSource,
  });
}

export async function fetchAvailableModelsForEndpoint({
  endpointType,
  endpointUrl,
  endpointHttpHeaders,
  errorSource,
}: {
  endpointType: EndpointType;
  endpointUrl: string | undefined;
  endpointHttpHeaders: [string, string][] | undefined;
  errorSource: string;
}): Promise<string[]> {
  return await fetchModelsForEndpoint({
    endpointType,
    endpointUrl,
    endpointHttpHeaders,
    errorSource,
  });
}
