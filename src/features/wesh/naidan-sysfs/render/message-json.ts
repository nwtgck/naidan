import type { MessageNode } from '@/01-models/types';
import type { ToolExecutionResult } from '@/01-models/tool';
import { truncateNaidanSysfsTextForJson } from './truncate';

function renderToolResult({ result }: { result: ToolExecutionResult }) {
  switch (result.status) {
  case 'executing': return { toolCallId: result.toolCallId, status: result.status };
  case 'success':
    switch (result.content.type) {
    case 'text': return { ...result, content: { type: 'text' as const, text: truncateNaidanSysfsTextForJson({ text: result.content.text }) } };
    case 'binary_object': return { ...result, content: { ...result.content } };
    default: { const _ex: never = result.content; throw new Error(`Unhandled tool content: ${_ex}`); }
    }
  case 'error':
    switch (result.error.message.type) {
    case 'text': return { ...result, error: { ...result.error, message: { type: 'text' as const, text: truncateNaidanSysfsTextForJson({ text: result.error.message.text }) } } };
    case 'binary_object': return { ...result, error: { ...result.error, message: { ...result.error.message } } };
    default: { const _ex: never = result.error.message; throw new Error(`Unhandled tool error content: ${_ex}`); }
    }
  default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
  }
}

function renderPart({ part }: { part: MessageNode['parts'][number] }) {
  switch (part.type) {
  case 'text':
  case 'reasoning': {
    const completeness = (() => {
      switch (part.completeness) {
      case 'complete': return undefined;
      case 'partial': return 'partial' as const;
      default: { const _ex: never = part.completeness; throw new Error(`Unhandled completeness: ${_ex}`); }
      }
    })();
    return { id: part.id, type: part.type, text: part.text, completeness };
  }
  case 'attachment': {
    const attachment = part.attachment;
    // Only metadata is visible here, including when the attachment owns a Blob.
    return { id: part.id, type: part.type, attachment: {
      id: attachment.id, binaryObjectId: attachment.binaryObjectId, name: attachment.originalName,
      mimeType: attachment.mimeType, size: attachment.size, uploadedAt: attachment.uploadedAt,
      status: attachment.status, note: '[binary attachment hidden]',
    } };
  }
  case 'tool_call': return { id: part.id, type: part.type, toolCall: {
    id: part.toolCall.id, type: part.toolCall.type,
    function: { name: part.toolCall.function.name, arguments: part.toolCall.function.arguments },
  } };
  case 'tool_result': return { id: part.id, type: part.type, result: renderToolResult({ result: part.result }) };
  default: { const _ex: never = part; throw new Error(`Unhandled message part: ${_ex}`); }
  }
}

export function renderMessageJson({ node }: { node: MessageNode }): string {
  const interruption = (() => {
    switch (node.role) {
    case 'assistant': return node.interruption;
    case 'user':
    case 'system':
    case 'tool': return undefined;
    default: { const _ex: never = node; throw new Error(`Unhandled message: ${_ex}`); }
    }
  })();
  return JSON.stringify({
    id: node.id,
    role: node.role,
    createdAt: node.createdAt,
    modelId: node.modelId,
    lmParameters: node.lmParameters,
    parts: node.parts.map(part => renderPart({ part })),
    interruption,
  }, null, 2);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
