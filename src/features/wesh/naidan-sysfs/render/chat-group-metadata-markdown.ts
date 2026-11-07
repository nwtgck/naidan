import { idToRaw } from '@/01-models/ids';
import type { ChatGroup } from '@/01-models/types';

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
export function renderChatGroupMetadataMarkdown({ chatGroup }: { chatGroup: ChatGroup }): string {
  return `\
# Chat Group Metadata

id: ${idToRaw({ id: chatGroup.id })}
name: ${chatGroup.name}
isCollapsed: ${chatGroup.isCollapsed}
updatedAt: ${chatGroup.updatedAt}
modelId: ${formatValue({ value: chatGroup.modelId })}
titleGeneration: ${formatValue({ value: chatGroup.titleGeneration })}
systemPrompt: ${formatValue({ value: chatGroup.systemPrompt })}
lmParameters: ${formatValue({ value: chatGroup.lmParameters })}
endpoint: ${formatValue({ value: chatGroup.endpoint })}
mounts: ${formatValue({ value: chatGroup.mounts })}
items: ${formatValue({ value: chatGroup.items.map(item => idToRaw({ id: item.chat.id })) })}
`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
