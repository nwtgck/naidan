import { idToRaw } from '@/models/ids';
import type { ChatGroup, Endpoint } from '@/models/types';
import { cloneEndpoint, isHttpEndpoint } from '@/models/endpoint';

function formatValue({ value }: { value: unknown }): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function maskEndpoint({ endpoint }: { endpoint: Endpoint | undefined }): Endpoint | undefined {
  if (endpoint === undefined) return undefined;
  const cloned = cloneEndpoint({ endpoint });
  if (!isHttpEndpoint(cloned)) return cloned;
  return {
    ...cloned,
    httpHeaders: cloned.httpHeaders?.map(([name]) => [name, '[masked]']),
  };
}

// Sensitive fields must be masked before rendering. Do not emit raw secret values here.
export function renderChatGroupMetadataMarkdown({ chatGroup }: { chatGroup: ChatGroup }): string {
  return `\
# Chat Group Metadata

id: ${idToRaw({ id: chatGroup.id })}
name: ${chatGroup.name}
isCollapsed: ${chatGroup.isCollapsed}
updatedAt: ${chatGroup.updatedAt}
modelId: ${formatValue({ value: chatGroup.modelId })}
autoTitleEnabled: ${formatValue({ value: chatGroup.autoTitleEnabled })}
titleModelId: ${formatValue({ value: chatGroup.titleModelId })}
systemPrompt: ${formatValue({ value: chatGroup.systemPrompt })}
lmParameters: ${formatValue({ value: chatGroup.lmParameters })}
endpoint: ${formatValue({ value: maskEndpoint({ endpoint: chatGroup.endpoint }) })}
mounts: ${formatValue({ value: chatGroup.mounts })}
items: ${formatValue({ value: chatGroup.items.map(item => idToRaw({ id: item.chat.id })) })}
`;
}
