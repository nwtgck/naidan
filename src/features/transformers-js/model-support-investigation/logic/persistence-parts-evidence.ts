import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';

// Fixed synthetic histories only: this is not a format for exporting user chats.
const textPartSchema = z.object({
  type: z.literal('text'), text: z.string(),
  completeness: z.enum(['complete', 'partial']),
});

export const persistencePartsMessageSchema = z.discriminatedUnion('role', [
  z.object({ id: z.string(), role: z.literal('system'), parts: z.array(textPartSchema) }),
  z.object({ id: z.string(), role: z.literal('user'), parts: z.array(textPartSchema) }),
  z.object({
    id: z.string(), role: z.literal('assistant'),
    parts: z.array(z.discriminatedUnion('type', [
      z.object({
        type: z.literal('reasoning'), text: z.string(),
        completeness: z.enum(['complete', 'partial']),
      }),
      textPartSchema,
      z.object({
        type: z.literal('tool_call'),
        toolCall: z.object({
          id: z.string(), type: z.literal('function'),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      }),
    ])),
  }),
  z.object({
    id: z.string(), role: z.literal('tool'),
    parts: z.array(z.object({
      type: z.literal('tool_result'),
      result: z.discriminatedUnion('status', [
        z.object({ toolCallId: z.string(), status: z.literal('executing') }),
        z.object({
          toolCallId: z.string(), status: z.literal('success'),
          content: z.object({ type: z.literal('text'), text: z.string() }),
        }),
        z.object({
          toolCallId: z.string(), status: z.literal('error'),
          error: z.object({
            code: z.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']),
            message: z.object({ type: z.literal('text'), text: z.string() }),
          }),
        }),
      ]),
    })),
  }),
]);

export type PersistencePartsMessage = z.infer<typeof persistencePartsMessageSchema>;

/** Keeps the shared request's part boundaries; it does not render a model template. */
export function recordPersistencePartsMessages({ messages }: {
  messages: readonly ChatMessage[],
}): PersistencePartsMessage[] {
  return messages.map((message) => {
    const { id, role, parts, ...unhandledMessage } = message;
    unhandledMessage satisfies Record<PropertyKey, never>;
    const recordedParts = parts.map((part) => {
      switch (part.type) {
      case 'text':
      case 'reasoning': {
        const { type, text, completeness, ...unhandledPart } = part;
        unhandledPart satisfies Record<PropertyKey, never>;
        return { type, text, completeness };
      }
      case 'tool_call': {
        const { type, toolCall, ...unhandledPart } = part;
        unhandledPart satisfies Record<PropertyKey, never>;
        const { id: callId, type: callType, function: fn, ...unhandledCall } = toolCall;
        unhandledCall satisfies Record<PropertyKey, never>;
        const { name, arguments: args, ...unhandledFunction } = fn;
        unhandledFunction satisfies Record<PropertyKey, never>;
        return { type, toolCall: { id: idToRaw({ id: callId }), type: callType, function: { name, arguments: args } } };
      }
      case 'tool_result': {
        const { type, result, ...unhandledPart } = part;
        unhandledPart satisfies Record<PropertyKey, never>;
        switch (result.status) {
        case 'executing': {
          const { toolCallId, status, ...unhandledResult } = result;
          unhandledResult satisfies Record<PropertyKey, never>;
          return { type, result: { toolCallId: idToRaw({ id: toolCallId }), status } };
        }
        case 'success': {
          const { toolCallId, status, content, ...unhandledResult } = result;
          unhandledResult satisfies Record<PropertyKey, never>;
          switch (content.type) {
          case 'text': {
            const { type: contentType, text, ...unhandledContent } = content;
            unhandledContent satisfies Record<PropertyKey, never>;
            return { type, result: { toolCallId: idToRaw({ id: toolCallId }), status, content: { type: contentType, text } } };
          }
          case 'binary_object':
            throw new Error('The persistence fixture must not contain binary tool results');
          default: {
            const unhandled: never = content;
            throw new Error(`Unhandled persistence result content: ${unhandled}`);
          }
          }
        }
        case 'error': {
          const { toolCallId, status, error, ...unhandledResult } = result;
          unhandledResult satisfies Record<PropertyKey, never>;
          const { code, message, ...unhandledError } = error;
          unhandledError satisfies Record<PropertyKey, never>;
          switch (message.type) {
          case 'text': {
            const { type: messageType, text, ...unhandledContent } = message;
            unhandledContent satisfies Record<PropertyKey, never>;
            return { type, result: { toolCallId: idToRaw({ id: toolCallId }), status, error: { code, message: { type: messageType, text } } } };
          }
          case 'binary_object':
            throw new Error('The persistence fixture must not contain binary tool errors');
          default: {
            const unhandled: never = message;
            throw new Error(`Unhandled persistence error content: ${unhandled}`);
          }
          }
        }
        default: {
          const unhandled: never = result;
          throw new Error(`Unhandled persistence tool result: ${unhandled}`);
        }
        }
      }
      case 'attachment':
        throw new Error('The persistence fixture must not contain attachments');
      default: {
        const unhandled: never = part;
        throw new Error(`Unhandled persistence part: ${unhandled}`);
      }
      }
    });
    return persistencePartsMessageSchema.parse({ id: idToRaw({ id }), role, parts: recordedParts });
  });
}

export function firstPersistencePartsMismatch({ expected, actual }: {
  expected: readonly PersistencePartsMessage[],
  actual: readonly PersistencePartsMessage[],
}): number | undefined {
  const sharedLength = Math.min(expected.length, actual.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) return index;
  }
  return expected.length === actual.length ? undefined : sharedLength;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
