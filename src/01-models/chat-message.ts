import type { Attachment, ChatMessage, MessageNode } from './types';
import type { ToolExecutionResult } from './tool';
import { exactObject } from '@/utils/exact-object';

function copyAttachment({ attachment }: { attachment: Attachment }): Attachment {
  const { id, binaryObjectId, originalName, mimeType, size, uploadedAt, ...variant } = attachment;
  const common = { id, binaryObjectId, originalName, mimeType, size, uploadedAt };
  switch (variant.status) {
  case 'memory': {
    const { status, blob, ...unhandled } = variant;
    unhandled satisfies Record<PropertyKey, never>;
    // Blob contents are immutable; copy the metadata but keep the binary object.
    return exactObject<Extract<Attachment, { status: 'memory' }>>()({ ...common, status, blob });
  }
  case 'persisted':
  case 'missing': {
    const { status, ...unhandled } = variant;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<Attachment, { status: 'persisted' | 'missing' }>>()({ ...common, status });
  }
  default: {
    const _ex: never = variant;
    throw new Error(`Unhandled attachment: ${_ex}`);
  }
  }
}

function copyToolContent({ content }: { content: Extract<ToolExecutionResult, { status: 'success' }>['content'] }) {
  switch (content.type) {
  case 'text': {
    const { type, text, ...unhandled } = content;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<typeof content, { type: 'text' }>>()({ type, text });
  }
  case 'binary_object': {
    const { type, id, ...unhandled } = content;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<typeof content, { type: 'binary_object' }>>()({ type, id });
  }
  default: {
    const _ex: never = content;
    throw new Error(`Unhandled tool content: ${_ex}`);
  }
  }
}

/** Copies model-visible content without carrying mutable history nodes into a request. */
export function createChatMessageSnapshot({ node }: { node: MessageNode }): ChatMessage {
  const { createdAt: _createdAt, replies: _replies, modelId: _modelId, lmParameters: _lmParameters, ...message } = node;
  switch (message.role) {
  case 'assistant': {
    const { interruption: _interruption, ...content } = message;
    return copyChatMessage({ message: content });
  }
  case 'user':
  case 'system':
  case 'tool': return copyChatMessage({ message });
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
}

/** Capture the request at chat invocation, before an iterator or binary read yields. */
export function copyChatMessage({ message }: { message: ChatMessage }): ChatMessage {
  switch (message.role) {
  case 'user': {
    const { id, role, parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ChatMessage, { role: 'user' }>>()({
      id, role,
      parts: parts.map(part => {
        switch (part.type) {
        case 'text': {
          const { type, text, completeness, ...unhandledPart } = part;
          unhandledPart satisfies Record<PropertyKey, never>;
          return exactObject<typeof part>()({ type, text, completeness });
        }
        case 'attachment': {
          const { type, attachment, ...unhandledPart } = part;
          unhandledPart satisfies Record<PropertyKey, never>;
          return exactObject<typeof part>()({ type, attachment: copyAttachment({ attachment }) });
        }
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled user part: ${_ex}`);
        }
        }
      }),
    });
  }
  case 'assistant': {
    const { id, role, parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ChatMessage, { role: 'assistant' }>>()({
      id, role,
      parts: parts.map(part => {
        switch (part.type) {
        case 'reasoning':
        case 'text': {
          const { type, text, completeness, ...unhandledPart } = part;
          unhandledPart satisfies Record<PropertyKey, never>;
          return exactObject<typeof part>()({ type, text, completeness });
        }
        case 'tool_call': {
          const { type, toolCall, ...unhandledPart } = part;
          unhandledPart satisfies Record<PropertyKey, never>;
          const { id: callId, type: callType, function: fn, ...unhandledCall } = toolCall;
          unhandledCall satisfies Record<PropertyKey, never>;
          const { name, arguments: argumentsText, ...unhandledFunction } = fn;
          unhandledFunction satisfies Record<PropertyKey, never>;
          return exactObject<typeof part>()({ type, toolCall: exactObject<typeof toolCall>()({
            id: callId, type: callType,
            function: exactObject<typeof fn>()({ name, arguments: argumentsText }),
          }) });
        }
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled assistant part: ${_ex}`);
        }
        }
      }),
    });
  }
  case 'system': {
    const { id, role, parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ChatMessage, { role: 'system' }>>()({
      id, role,
      parts: parts.map(part => {
        const { type, text, completeness, ...unhandledPart } = part;
        unhandledPart satisfies Record<PropertyKey, never>;
        return exactObject<typeof part>()({ type, text, completeness });
      }),
    });
  }
  case 'tool': {
    const { id, role, parts, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ChatMessage, { role: 'tool' }>>()({
      id, role,
      parts: parts.map(part => {
        const { type, result, ...unhandledPart } = part;
        unhandledPart satisfies Record<PropertyKey, never>;
        let copy: ToolExecutionResult;
        switch (result.status) {
        case 'executing': {
          const { toolCallId, status, ...unhandledResult } = result;
          unhandledResult satisfies Record<PropertyKey, never>;
          copy = exactObject<typeof result>()({ toolCallId, status });
          break;
        }
        case 'success': {
          const { toolCallId, status, content, ...unhandledResult } = result;
          unhandledResult satisfies Record<PropertyKey, never>;
          copy = exactObject<typeof result>()({ toolCallId, status, content: copyToolContent({ content }) });
          break;
        }
        case 'error': {
          const { toolCallId, status, error, ...unhandledResult } = result;
          unhandledResult satisfies Record<PropertyKey, never>;
          const { code, message, ...unhandledError } = error;
          unhandledError satisfies Record<PropertyKey, never>;
          copy = exactObject<typeof result>()({ toolCallId, status, error: exactObject<typeof error>()({ code, message: copyToolContent({ content: message }) }) });
          break;
        }
        default: {
          const _ex: never = result;
          throw new Error(`Unhandled tool result: ${_ex}`);
        }
        }
        return exactObject<typeof part>()({ type, result: copy });
      }),
    });
  }
  default: {
    const _ex: never = message;
    throw new Error(`Unhandled message: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
