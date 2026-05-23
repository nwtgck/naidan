import type { ChatMeta } from '@/models/types'

function formatValue({ value }: { value: unknown }): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'string') {
    return value
  }
  return JSON.stringify(value)
}

// Sensitive fields must be masked before rendering. Do not emit raw secret values here.
export function renderChatMetadataMarkdown({ metadata }: { metadata: ChatMeta }): string {
  return `\
# Chat Metadata

id: ${metadata.id}
title: ${formatValue({ value: metadata.title })}
groupId: ${formatValue({ value: metadata.groupId })}
currentLeafId: ${formatValue({ value: metadata.currentLeafId })}
createdAt: ${metadata.createdAt}
updatedAt: ${metadata.updatedAt}
debugEnabled: ${metadata.debugEnabled}
modelId: ${formatValue({ value: metadata.modelId })}
autoTitleEnabled: ${formatValue({ value: metadata.autoTitleEnabled })}
titleModelId: ${formatValue({ value: metadata.titleModelId })}
originChatId: ${formatValue({ value: metadata.originChatId })}
originMessageId: ${formatValue({ value: metadata.originMessageId })}
systemPrompt: ${formatValue({ value: metadata.systemPrompt })}
lmParameters: ${formatValue({ value: metadata.lmParameters })}
endpoint: ${formatValue({ value: metadata.endpoint ? {
    ...metadata.endpoint,
    httpHeaders: metadata.endpoint.httpHeaders?.map(([name]) => [name, '[masked]']),
  } : undefined })}
mounts: ${formatValue({ value: metadata.mounts })}
`
}
