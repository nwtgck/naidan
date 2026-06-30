import type { ChatGroup, Endpoint, Mount } from '@/01-models/types';
import { cloneEndpoint, isHttpEndpoint } from '@/01-models/endpoint';

function maskEndpoint({ endpoint }: { endpoint: Endpoint | undefined }): Endpoint | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  const cloned = cloneEndpoint({ endpoint });
  if (!isHttpEndpoint(cloned)) {
    return cloned;
  }
  return {
    ...cloned,
    httpHeaders: cloned.httpHeaders?.map(([name]) => [name, '[masked]']),
  };
}

function cloneMounts({ mounts }: { mounts: Mount[] | undefined }): Mount[] | undefined {
  return mounts?.map(mount => ({ ...mount }));
}

// Sensitive fields must be masked before rendering. Do not emit raw secret values here.
export function renderChatGroupMetadataJson({ chatGroup }: { chatGroup: ChatGroup }): string {
  return JSON.stringify({
    id: chatGroup.id,
    name: chatGroup.name,
    isCollapsed: chatGroup.isCollapsed,
    updatedAt: chatGroup.updatedAt,
    endpoint: maskEndpoint({ endpoint: chatGroup.endpoint }),
    modelId: chatGroup.modelId,
    autoTitleEnabled: chatGroup.autoTitleEnabled,
    titleModelId: chatGroup.titleModelId,
    systemPrompt: chatGroup.systemPrompt,
    lmParameters: chatGroup.lmParameters,
    mounts: cloneMounts({ mounts: chatGroup.mounts }),
    items: chatGroup.items.map(item => item.chat.id),
  }, null, 2);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
