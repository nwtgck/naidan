import type { ChatGroup, Endpoint, Mount } from '@/models/types';

function maskEndpoint({ endpoint }: { endpoint: Endpoint | undefined }): Endpoint | undefined {
  if (endpoint === undefined) {
    return undefined;
  }
  return {
    ...endpoint,
    httpHeaders: endpoint.httpHeaders?.map(([name]) => [name, '[masked]']),
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
