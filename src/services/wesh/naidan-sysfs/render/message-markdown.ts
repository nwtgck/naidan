import type { Attachment, MessageNode } from '@/models/types'
import { idToRaw } from '@/models/ids'
import type { ToolExecutionResult } from '@/services/tools/types'
import { truncateNaidanSysfsTextForMarkdown } from './truncate'

function renderAttachments({ attachments }: { attachments: Attachment[] | undefined }): string[] {
  if (attachments === undefined || attachments.length === 0) {
    return ['attachments: []']
  }

  return [
    'attachments:',
    ...attachments.map(attachment => `- ${attachment.originalName} (${attachment.mimeType}, ${attachment.size} bytes, binary hidden)`),
  ]
}

function renderResults({ results }: { results: ToolExecutionResult[] | undefined }): string[] {
  if (results === undefined || results.length === 0) {
    return ['results: []']
  }

  return [
    'results:',
    ...results.map(result => {
      switch (result.status) {
      case 'executing':
        return `- ${idToRaw({ id: result.toolCallId })}: executing`
      case 'success':
        switch (result.content.type) {
        case 'text':
          return `- ${idToRaw({ id: result.toolCallId })}: success ${truncateNaidanSysfsTextForMarkdown({ text: result.content.text })}`
        case 'binary_object':
          return `- ${idToRaw({ id: result.toolCallId })}: success [binary object ${idToRaw({ id: result.content.id })}]`
        default: {
          const _ex: never = result.content
          throw new Error(`Unhandled tool result content: ${String(_ex)}`)
        }
        }
      case 'error':
        switch (result.error.message.type) {
        case 'text':
          return `- ${idToRaw({ id: result.toolCallId })}: error ${truncateNaidanSysfsTextForMarkdown({ text: result.error.message.text })}`
        case 'binary_object':
          return `- ${idToRaw({ id: result.toolCallId })}: error [binary object ${idToRaw({ id: result.error.message.id })}]`
        default: {
          const _ex: never = result.error.message
          throw new Error(`Unhandled tool error message: ${String(_ex)}`)
        }
        }
      default: {
        const _ex: never = result
        throw new Error(`Unhandled tool result status: ${String(_ex)}`)
      }
      }
    }),
  ]
}

export function renderMessageMarkdown({ node }: { node: MessageNode }): string {
  const lines = [
    `# Message ${idToRaw({ id: node.id })}`,
    '',
    `role: ${node.role}`,
    `timestamp: ${node.timestamp}`,
    `content: ${node.content ?? 'undefined'}`,
    `thinking: ${'thinking' in node ? node.thinking ?? 'undefined' : 'undefined'}`,
    `error: ${'error' in node ? node.error ?? 'undefined' : 'undefined'}`,
    `modelId: ${'modelId' in node ? node.modelId ?? 'undefined' : 'undefined'}`,
    `lmParameters: ${'lmParameters' in node ? JSON.stringify(node.lmParameters) : 'undefined'}`,
    ...('attachments' in node ? renderAttachments({ attachments: node.attachments }) : ['attachments: []']),
    `toolCalls: ${'toolCalls' in node ? JSON.stringify(node.toolCalls) : 'undefined'}`,
    ...('results' in node ? renderResults({ results: node.results }) : ['results: []']),
    '',
  ]

  return `${lines.join('\n')}\n`
}
