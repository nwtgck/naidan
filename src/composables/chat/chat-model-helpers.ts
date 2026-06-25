import type { Chat, ChatGroup, EndpointType, Settings } from '@/models/types';

export function resolveChatEndpointForChat({
  chat,
  chatGroups,
  settings,
}: {
  chat: Pick<Chat, 'groupId' | 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders'>,
  chatGroups: readonly ChatGroup[],
  settings: {
    endpointType: Settings['endpointType'],
    endpointUrl?: Settings['endpointUrl'],
    endpointHttpHeaders?: readonly (readonly [string, string])[] | undefined,
  },
}): {
  type: EndpointType,
  url: string | undefined,
  headers: [string, string][] | undefined,
} {
  const group = chat.groupId ? chatGroups.find(({ id }) => id === chat.groupId) : undefined;
  return {
    type: chat.endpointType || group?.endpoint?.type || settings.endpointType,
    url: chat.endpointUrl || group?.endpoint?.url || settings.endpointUrl,
    headers: cloneHeaders({
      headers: chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.endpointHttpHeaders,
    }),
  };
}

export function resolveGlobalEndpoint({
  settings,
}: {
  settings: {
    endpointType: Settings['endpointType'],
    endpointUrl?: Settings['endpointUrl'],
    endpointHttpHeaders?: readonly (readonly [string, string])[] | undefined,
  },
}): {
  type: EndpointType,
  url: string | undefined,
  headers: [string, string][] | undefined,
} {
  return {
    type: settings.endpointType,
    url: settings.endpointUrl,
    headers: cloneHeaders({
      headers: settings.endpointHttpHeaders,
    }),
  };
}

function cloneHeaders({
  headers,
}: {
  headers: readonly (readonly [string, string])[] | undefined,
}): [string, string][] | undefined {
  return headers ? headers.map(([name, value]) => [name, value]) : undefined;
}
