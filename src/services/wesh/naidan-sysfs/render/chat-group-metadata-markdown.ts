import type { ChatGroup } from '@/models/types'

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
export function renderChatGroupMetadataMarkdown({ chatGroup }: { chatGroup: ChatGroup }): string {
  return `\
# Chat Group Metadata

id: ${chatGroup.id}
name: ${chatGroup.name}
isCollapsed: ${chatGroup.isCollapsed}
updatedAt: ${chatGroup.updatedAt}
modelId: ${formatValue({ value: chatGroup.modelId })}
autoTitleEnabled: ${formatValue({ value: chatGroup.autoTitleEnabled })}
titleModelId: ${formatValue({ value: chatGroup.titleModelId })}
systemPrompt: ${formatValue({ value: chatGroup.systemPrompt })}
lmParameters: ${formatValue({ value: chatGroup.lmParameters })}
endpoint: ${formatValue({ value: chatGroup.endpoint ? {
    ...chatGroup.endpoint,
    httpHeaders: chatGroup.endpoint.httpHeaders?.map(([name]) => [name, '[masked]']),
  } : undefined })}
mounts: ${formatValue({ value: chatGroup.mounts })}
items: ${formatValue({ value: chatGroup.items.map(item => item.chat.id) })}
`
}
