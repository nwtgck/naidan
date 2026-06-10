import type { ChatMeta, Endpoint, Mount } from '@/models/types'

function maskEndpoint({ endpoint }: { endpoint: Endpoint | undefined }): Endpoint | undefined {
  if (endpoint === undefined) {
    return undefined
  }
  return {
    ...endpoint,
    httpHeaders: endpoint.httpHeaders?.map(([name]) => [name, '[masked]']),
  }
}

function cloneMounts({ mounts }: { mounts: Mount[] | undefined }): Mount[] | undefined {
  return mounts?.map(mount => ({ ...mount }))
}

// Sensitive fields must be masked before rendering. Do not emit raw secret values here.
export function renderChatMetadataJson({ metadata }: { metadata: ChatMeta }): string {
  return JSON.stringify({
    id: metadata.id,
    title: metadata.title,
    groupId: metadata.groupId,
    currentLeafId: metadata.currentLeafId,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    debugEnabled: metadata.debugEnabled,
    endpoint: maskEndpoint({ endpoint: metadata.endpoint }),
    modelId: metadata.modelId,
    autoTitleEnabled: metadata.autoTitleEnabled,
    titleModelId: metadata.titleModelId,
    originChatId: metadata.originChatId,
    originMessageId: metadata.originMessageId,
    systemPrompt: metadata.systemPrompt,
    lmParameters: metadata.lmParameters,
    mounts: cloneMounts({ mounts: metadata.mounts }),
  }, null, 2)
}
