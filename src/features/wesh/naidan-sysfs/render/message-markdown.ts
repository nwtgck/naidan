import type { MessageNode } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import type { ToolExecutionResult } from '@/01-models/tool';
import { truncateNaidanSysfsTextForMarkdown } from './truncate';

function renderResult({ result }: { result: ToolExecutionResult }): string {
  const id = idToRaw({ id: result.toolCallId });
  switch (result.status) {
  case 'executing': return `${id}: executing`;
  case 'success':
    switch (result.content.type) {
    case 'text': return `${id}: success ${truncateNaidanSysfsTextForMarkdown({ text: result.content.text })}`;
    case 'binary_object': return `${id}: success [binary object ${idToRaw({ id: result.content.id })}]`;
    default: { const _ex: never = result.content; throw new Error(`Unhandled tool content: ${_ex}`); }
    }
  case 'error':
    switch (result.error.message.type) {
    case 'text': return `${id}: error ${truncateNaidanSysfsTextForMarkdown({ text: result.error.message.text })}`;
    case 'binary_object': return `${id}: error [binary object ${idToRaw({ id: result.error.message.id })}]`;
    default: { const _ex: never = result.error.message; throw new Error(`Unhandled tool error: ${_ex}`); }
    }
  default: { const _ex: never = result; throw new Error(`Unhandled tool result: ${_ex}`); }
  }
}

export function renderMessageMarkdown({ node }: { node: MessageNode }): string {
  const lines = [
    `# Message ${idToRaw({ id: node.id })}`, '',
    `role: ${node.role}`, `createdAt: ${node.createdAt}`,
    `modelId: ${node.modelId ?? 'undefined'}`,
    `lmParameters: ${JSON.stringify(node.lmParameters)}`,
  ];
  switch (node.role) {
  case 'assistant':
    if (node.interruption !== undefined) lines.push(`interruption: ${JSON.stringify(node.interruption)}`);
    break;
  case 'user':
  case 'system':
  case 'tool': break;
  default: { const _ex: never = node; throw new Error(`Unhandled message: ${_ex}`); }
  }
  if (node.parts.length === 0) lines.push('parts: []');
  for (const [index, part] of node.parts.entries()) {
    lines.push('', `## Part ${index + 1} (${part.type})`);
    switch (part.type) {
    case 'text':
    case 'reasoning':
      lines.push(`completeness: ${part.completeness}`, '', part.text);
      break;
    case 'attachment':
      lines.push(`${part.attachment.originalName} (${part.attachment.mimeType}, ${part.attachment.size} bytes, binary hidden)`);
      break;
    case 'tool_call': lines.push(JSON.stringify(part.toolCall)); break;
    case 'tool_result': lines.push(renderResult({ result: part.result })); break;
    default: { const _ex: never = part; throw new Error(`Unhandled message part: ${_ex}`); }
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
