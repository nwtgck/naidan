import { idToRaw } from '@/01-models/ids';
import type { ChatMeta } from '@/01-models/types';

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


// Domain Secret values mask themselves, including nested title-generation credentials.
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
titleGeneration: ${formatValue({ value: metadata.titleGeneration })}
originChatId: ${formatValue({ value: metadata.originChatId === undefined ? undefined : idToRaw({ id: metadata.originChatId }) })}
originMessageId: ${formatValue({ value: metadata.originMessageId === undefined ? undefined : idToRaw({ id: metadata.originMessageId }) })}
systemPrompt: ${formatValue({ value: metadata.systemPrompt })}
lmParameters: ${formatValue({ value: metadata.lmParameters })}
endpoint: ${formatValue({ value: metadata.endpoint })}
mounts: ${formatValue({ value: metadata.mounts })}
`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
