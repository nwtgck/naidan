import type { ChatGroup, Mount } from '@/01-models/types';


function cloneMounts({ mounts }: { mounts: Mount[] | undefined }): Mount[] | undefined {
  return mounts?.map(mount => ({ ...mount }));
}

// Domain Secret values mask themselves, including nested title-generation credentials.
export function renderChatGroupMetadataJson({ chatGroup }: { chatGroup: ChatGroup }): string {
  return JSON.stringify({
    id: chatGroup.id,
    name: chatGroup.name,
    isCollapsed: chatGroup.isCollapsed,
    updatedAt: chatGroup.updatedAt,
    endpoint: chatGroup.endpoint,
    modelId: chatGroup.modelId,
    titleGeneration: chatGroup.titleGeneration,
    systemPrompt: chatGroup.systemPrompt,
    lmParameters: chatGroup.lmParameters,
    mounts: cloneMounts({ mounts: chatGroup.mounts }),
    items: chatGroup.items.map(item => item.chat.id),
  }, null, 2);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
