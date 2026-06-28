import type { Attachment, MessageNode, ToolCall } from '@/01-models/types';
import type { ToolExecutionResult } from '@/01-models/tool';
import { truncateNaidanSysfsTextForJson } from './truncate';

function renderAttachments({ attachments }: { attachments: Attachment[] | undefined }) {
  return attachments?.map(attachment => ({
    id: attachment.id,
    binaryObjectId: attachment.binaryObjectId,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    uploadedAt: attachment.uploadedAt,
    status: attachment.status,
    note: '[binary attachment hidden]',
  }));
}

function renderToolCalls({ toolCalls }: { toolCalls: ToolCall[] | undefined }) {
  return toolCalls?.map(toolCall => ({
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  }));
}

function renderToolResults({ results }: { results: ToolExecutionResult[] | undefined }) {
  return results?.map(result => {
    switch (result.status) {
    case 'executing':
      return result;
    case 'success':
      switch (result.content.type) {
      case 'text':
        return {
          ...result,
          content: {
            type: 'text' as const,
            text: truncateNaidanSysfsTextForJson({ text: result.content.text }),
          },
        };
      case 'binary_object':
        return result;
      default: {
        const _ex: never = result.content;
        throw new Error(`Unhandled tool result content: ${String(_ex)}`);
      }
      }
    case 'error':
      switch (result.error.message.type) {
      case 'text':
        return {
          ...result,
          error: {
            ...result.error,
            message: {
              type: 'text' as const,
              text: truncateNaidanSysfsTextForJson({ text: result.error.message.text }),
            },
          },
        };
      case 'binary_object':
        return result;
      default: {
        const _ex: never = result.error.message;
        throw new Error(`Unhandled tool error message: ${String(_ex)}`);
      }
      }
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled tool result status: ${String(_ex)}`);
    }
    }
  });
}

export function renderMessageJson({ node }: { node: MessageNode }): string {
  return JSON.stringify({
    id: node.id,
    role: node.role,
    timestamp: node.timestamp,
    content: node.content,
    thinking: 'thinking' in node ? node.thinking : undefined,
    error: 'error' in node ? node.error : undefined,
    modelId: 'modelId' in node ? node.modelId : undefined,
    lmParameters: 'lmParameters' in node ? node.lmParameters : undefined,
    attachments: 'attachments' in node ? renderAttachments({ attachments: node.attachments }) : undefined,
    toolCalls: 'toolCalls' in node ? renderToolCalls({ toolCalls: node.toolCalls }) : undefined,
    results: 'results' in node ? renderToolResults({ results: node.results }) : undefined,
  }, null, 2);
}
