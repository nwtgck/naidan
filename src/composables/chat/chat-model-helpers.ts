import type { Chat, ChatGroup, Endpoint, Settings } from '@/01-models/types';
import { cloneEndpoint } from '@/01-models/endpoint';

export function resolveChatEndpointForChat({
  chat,
  chatGroups,
  settings,
}: {
  chat: Pick<Chat, 'groupId' | 'endpoint'>,
  chatGroups: readonly ChatGroup[],
  settings: Pick<Settings, 'endpoint'>,
}): Endpoint {
  const group = chat.groupId
    ? chatGroups.find(({ id }) => id === chat.groupId)
    : undefined;
  return cloneEndpoint({
    endpoint: chat.endpoint ?? group?.endpoint ?? settings.endpoint,
  });
}

export function resolveGlobalEndpoint({
  settings,
}: {
  settings: Pick<Settings, 'endpoint'>,
}): Endpoint {
  return cloneEndpoint({ endpoint: settings.endpoint });
}
