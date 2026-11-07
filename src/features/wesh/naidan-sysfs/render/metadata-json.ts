import type { ChatMeta, Mount } from '@/01-models/types';


function cloneMounts({ mounts }: { mounts: Mount[] | undefined }): Mount[] | undefined {
  return mounts?.map(mount => ({ ...mount }));
}

// Domain Secret values mask themselves, including nested title-generation credentials.
export function renderChatMetadataJson({ metadata }: { metadata: ChatMeta }): string {
  return JSON.stringify({
    id: metadata.id,
    title: metadata.title,
    groupId: metadata.groupId,
    currentLeafId: metadata.currentLeafId,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    debugEnabled: metadata.debugEnabled,
    endpoint: metadata.endpoint,
    modelId: metadata.modelId,
    titleGeneration: metadata.titleGeneration,
    originChatId: metadata.originChatId,
    originMessageId: metadata.originMessageId,
    systemPrompt: metadata.systemPrompt,
    lmParameters: metadata.lmParameters,
    mounts: cloneMounts({ mounts: metadata.mounts }),
  }, null, 2);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
