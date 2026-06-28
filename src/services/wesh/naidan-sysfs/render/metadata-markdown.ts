import { idToRaw } from '@/models/ids';
import type { ChatMeta, Endpoint } from '@/models/types';
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
export function renderChatMetadataMarkdown({ metadata }: { metadata: ChatMeta }): string {
  return `\
# Chat Metadata

id: ${idToRaw({ id: metadata.id })}
title: ${formatValue({ value: metadata.title })}
groupId: ${formatValue({ value: metadata.groupId === undefined || metadata.groupId === null ? metadata.groupId : idToRaw({ id: metadata.groupId }) })}
currentLeafId: ${formatValue({ value: metadata.currentLeafId === undefined ? undefined : idToRaw({ id: metadata.currentLeafId }) })}
createdAt: ${metadata.createdAt}
updatedAt: ${metadata.updatedAt}
debugEnabled: ${metadata.debugEnabled}
modelId: ${formatValue({ value: metadata.modelId })}
autoTitleEnabled: ${formatValue({ value: metadata.autoTitleEnabled })}
titleModelId: ${formatValue({ value: metadata.titleModelId })}
originChatId: ${formatValue({ value: metadata.originChatId === undefined ? undefined : idToRaw({ id: metadata.originChatId }) })}
originMessageId: ${formatValue({ value: metadata.originMessageId === undefined ? undefined : idToRaw({ id: metadata.originMessageId }) })}
systemPrompt: ${formatValue({ value: metadata.systemPrompt })}
lmParameters: ${formatValue({ value: metadata.lmParameters })}
endpoint: ${formatValue({ value: maskEndpoint({ endpoint: metadata.endpoint }) })}
mounts: ${formatValue({ value: metadata.mounts })}
`;
}
