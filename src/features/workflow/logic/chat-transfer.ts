import type { ChatMessage, Endpoint, LmParameters } from '@/01-models/types';
import type { BinaryObjectId, WorkflowStepId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import { cloneEndpoint } from '@/01-models/endpoint';
import { copyChatMessage } from '@/01-models/chat-message';
import type { TextOrBinaryObject } from '@/01-models/tool';
import type { WorkflowDefinition, WorkflowMessage, WorkflowMessagePart } from '@/01-models/workflow';
import { materializeWorkflowConversation } from './conversation';
import type { RuntimeMessage } from './values';

/** Capture content only. No mounts, tool settings, saved approvals, branches,
 * running operations, or binary handles are copied into the new definition.
 */
export async function workflowFromChat({ messages, title, endpoint, modelId, lmParameters, systemPrompts, inputLabel, signal, readBinaryObject }: {
  messages: readonly ChatMessage[], title: string, endpoint: Endpoint, modelId: string,
  lmParameters: LmParameters, systemPrompts: readonly string[], inputLabel: string,
  signal: AbortSignal,
  readBinaryObject: ({ id, signal }: { id: BinaryObjectId, signal: AbortSignal }) => Promise<Blob | null>,
}): Promise<WorkflowDefinition> {
  const snapshot = messages.map(message => copyChatMessage({ message }));
  const target = { endpoint: cloneEndpoint({ endpoint }), modelId };
  const parameters = structuredClone(lmParameters);
  const prompts = [...systemPrompts];
  let bytes = 0;
  const account = ({ text }: { text: string }): string => {
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 2 * 1024 * 1024) {
      throw new Error('Conversation exceeds the Workflow copy limit.');
    }
    return text;
  };
  const converted: WorkflowMessage[] = prompts.filter(Boolean).map(text => ({ role: 'system', parts: [{ type: 'text', text: account({ text }) }] }));
  if (snapshot.length + converted.length > 254 || snapshot.some(message => message.parts.length > 64)) {
    throw new Error('Conversation exceeds the Workflow message limit.');
  }
  const content = async ({ value }: { value: TextOrBinaryObject }): Promise<string> => {
    signal.throwIfAborted();
    switch (value.type) {
    case 'text': return account({ text: value.text });
    case 'binary_object': {
      const file = await readBinaryObject({ id: value.id, signal });
      if (!file || file.size > 2 * 1024 * 1024 - bytes) {
        throw new Error('A tool result is missing or exceeds the Workflow copy limit.');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      signal.throwIfAborted();
      return account({ text });
    }
    default: {
      const exhaustive: never = value;
      throw new Error(String(exhaustive));
    }
    }
  };
  for (const message of snapshot) {
    signal.throwIfAborted();
    const parts: WorkflowMessagePart[] = [];
    for (const part of message.parts) {
      switch (part.type) {
      case 'text': case 'reasoning':
        switch (part.completeness) {
        case 'complete': break;
        case 'partial': throw new Error('Finish or repair the partial conversation before copying it.');
        default: {
          const exhaustive: never = part.completeness;
          throw new Error(String(exhaustive));
        }
        }
        parts.push({ type: part.type, text: account({ text: part.text }) });
        break;
      case 'attachment': throw new Error('This conversation contains an attachment. Use Workflow file inputs instead; attachments are not silently discarded.');
      case 'tool_call': parts.push({ type: 'tool_call', id: part.toolCall.id, name: part.toolCall.function.name, arguments: account({ text: part.toolCall.function.arguments }) });
        break;
      case 'tool_result':
        switch (part.result.status) {
        case 'executing': throw new Error('Wait for the active tool call before copying the conversation.');
        case 'success': parts.push({ type: 'tool_result', id: part.result.toolCallId, status: 'success', code: undefined, content: { type: 'literal', value: await content({ value: part.result.content }) } });
          break;
        case 'error': parts.push({ type: 'tool_result', id: part.result.toolCallId, status: 'error', code: part.result.error.code, content: { type: 'literal', value: await content({ value: part.result.error.message }) } });
          break;
        default: {
          const exhaustive: never = part.result;
          throw new Error(String(exhaustive));
        }
        }
        break;
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }
    converted.push({ role: message.role, parts });
  }
  // The same role/pairing/byte contracts as actual generation. Conversion does
  // not dispatch historical calls even when their names match enabled tools.
  const runtime: RuntimeMessage[] = converted.map(message => ({
    role: message.role,
    parts: message.parts.map(part => {
      switch (part.type) {
      case 'text': return { type: 'json', value: part.text };
      case 'reasoning': return { type: 'reasoning', content: { type: 'json', value: part.text } };
      case 'tool_call': return { ...part };
      case 'tool_result':
        switch (part.content.type) {
        case 'literal': return { ...part, content: { type: 'json', value: part.content.value } };
        case 'model': case 'step_output': case 'loop_item': case 'loop_index': case 'loop_state':
        case 'array': case 'concat': case 'path': case 'object': case 'json_compose': case 'range': case 'get':
        case 'filename': case 'format_number': case 'equals': case 'arithmetic': case 'compare': case 'all': case 'any':
        case 'not': case 'not_empty': case 'conversation': throw new Error('Copied results must be literal text.');
        default: {
          const exhaustive: never = part.content;
          throw new Error(String(exhaustive));
        }
        }
      case 'value': throw new Error('Copied histories cannot contain executable references.');
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }),
  }));
  await materializeWorkflowConversation({ messages: runtime, signal });
  signal.throwIfAborted();
  const inputId = generateId<WorkflowStepId>();
  return {
    name: title,
    steps: [
      { id: inputId, name: inputLabel, type: 'request_input', prompt: { type: 'literal', value: inputLabel }, responseType: 'text' },
      {
        id: generateId<WorkflowStepId>(),
        name: title,
        type: 'text_generation',
        target: { type: 'model', ...target },
        conversation: { type: 'conversation', messages: converted },
        appendMessages: [{ role: 'user', parts: [{ type: 'value', value: { type: 'step_output', stepId: inputId, output: 'value' } }] }],
        systemPrompt: undefined,
        lmParameters: parameters,
        toolConfigs: [],
        toolExecution: undefined,
      },
    ],
  };
}

export const TEST_ONLY = {
};
