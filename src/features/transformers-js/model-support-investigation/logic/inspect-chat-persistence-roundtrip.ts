import type {
  ChatContent,
  ChatMessage,
  ToolMessageNode,
  UserMessageNode,
} from '@/01-models/types';
import { formatToolExecutionOutcomeForLm } from '@/01-models/tool';
import {
  idToRaw,
  toMessageId,
  toToolCallId,
} from '@/01-models/ids';
import { roundTripChatContentPersistenceSerialization } from '@/00-storage/service/chat-content-serialization';
import type {
  ModelSupportInvestigationPersistenceMessage,
  ModelSupportInvestigationPersistenceRoundTrip,
} from '@/features/transformers-js/model-support-investigation/types';
import { serializeInvestigationError } from '@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';

const fixtureId = 'tool-call-history-v1' as const;
const method = 'chat-content-dto-json-roundtrip-v1' as const;

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stableBytes.buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function fixedFixture(): ChatContent {
  const toolCallId = toToolCallId({ raw: 'model-support-investigation-tool-call-1' });
  const followUpId = toMessageId({ raw: 'model-support-investigation-follow-up' });
  const toolId = toMessageId({ raw: 'model-support-investigation-tool-result' });
  const assistantId = toMessageId({ raw: 'model-support-investigation-assistant' });
  const userId = toMessageId({ raw: 'model-support-investigation-user' });

  return {
    currentLeafId: followUpId,
    root: {
      items: [{
        id: userId,
        role: 'user',
        content: 'Use the weather tool for Tokyo.',
        timestamp: 1,
        replies: {
          items: [{
            id: assistantId,
            role: 'assistant',
            content: '<think>preserve this exact model-visible tool-call prefix</think>',
            timestamp: 2,
            toolCalls: [{
              id: toolCallId,
              type: 'function',
              function: {
                name: 'lookup_weather',
                arguments: `\
{
  "city": "Tokyo",
  "unit": "C"
}`,
              },
            }],
            replies: {
              items: [{
                id: toolId,
                role: 'tool',
                content: undefined,
                attachments: undefined,
                thinking: undefined,
                error: undefined,
                modelId: undefined,
                lmParameters: undefined,
                toolCalls: undefined,
                timestamp: 3,
                results: [{
                  toolCallId,
                  status: 'success',
                  content: {
                    type: 'text',
                    text: `\
{"temperatureC":20,"condition":"clear"}
source=fixture`,
                  },
                }],
                replies: {
                  items: [{
                    id: followUpId,
                    role: 'user',
                    content: 'Continue from the tool result.',
                    timestamp: 4,
                    replies: { items: [] },
                  }],
                },
              }],
            },
          }],
        },
      }],
    },
  };
}

async function getPersistenceFixtureToolResultText({
  result,
}: {
  result: ToolMessageNode['results'][number],
}): Promise<string> {
  switch (result.status) {
  case 'executing':
    return '[Error: Tool still executing]';
  case 'success':
    switch (result.content.type) {
    case 'text':
      return formatToolExecutionOutcomeForLm({ outcome: { status: 'success', content: result.content.text } });
    case 'binary_object':
      throw new Error('The persistence fixture must not contain binary tool-result content');
    default: {
      const _ex: never = result.content;
      return _ex;
    }
    }
  case 'error':
    switch (result.error.message.type) {
    case 'text':
      return formatToolExecutionOutcomeForLm({
        outcome: { status: 'error', code: result.error.code, message: result.error.message.text },
      });
    case 'binary_object':
      throw new Error('The persistence fixture must not contain binary tool-error content');
    default: {
      const _ex: never = result.error.message;
      return _ex;
    }
    }
  default: {
    const _ex: never = result;
    return _ex;
  }
  }
}

async function getPersistenceFixtureUserContent({
  message,
}: {
  message: UserMessageNode,
}): Promise<string> {
  if (message.attachments && message.attachments.length > 0) {
    throw new Error('The persistence fixture must not contain attachments');
  }
  return message.content;
}

function evidenceMessages({
  messages,
}: {
  messages: ChatMessage[],
}): ModelSupportInvestigationPersistenceMessage[] {
  return messages.map((message) => {
    if (typeof message.content !== 'string') {
      throw new Error('The persistence fixture must project to text-only LM content');
    }
    const role = (() => {
      switch (message.role) {
      case 'system':
      case 'user':
      case 'assistant':
      case 'tool':
        return message.role;
      default:
        throw new Error(`Unexpected persistence fixture role: ${message.role}`);
      }
    })();
    return {
      role,
      content: message.content,
      tool_calls: message.tool_calls?.map(toolCall => ({
        id: idToRaw({ id: toolCall.id }),
        type: toolCall.type,
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      })),
      tool_call_id: message.tool_call_id === undefined ? undefined : idToRaw({ id: message.tool_call_id }),
    };
  });
}

async function projectPersistenceFixture({
  content,
}: {
  content: ChatContent,
}): Promise<ModelSupportInvestigationPersistenceMessage[]> {
  const messages = await buildChatGenerationMessages({
    chat: content,
    excludedMessageId: undefined,
    systemPromptMessages: [],
    resolveUserContent: getPersistenceFixtureUserContent,
    resolveToolResultText: getPersistenceFixtureToolResultText,
  });
  return evidenceMessages({ messages });
}

function firstMismatchIndex({
  expected,
  actual,
}: {
  expected: ModelSupportInvestigationPersistenceMessage[],
  actual: ModelSupportInvestigationPersistenceMessage[],
}): number | undefined {
  const sharedLength = Math.min(expected.length, actual.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) return index;
  }
  return expected.length === actual.length ? undefined : sharedLength;
}

export async function inspectChatPersistenceRoundTrip(): Promise<ModelSupportInvestigationPersistenceRoundTrip> {
  try {
    const original = fixedFixture();
    const originalMessages = await projectPersistenceFixture({ content: original });
    const { restored, serialized } = roundTripChatContentPersistenceSerialization({ content: original });
    const bytes = new TextEncoder().encode(serialized);
    const restoredMessages = await projectPersistenceFixture({ content: restored });
    const mismatch = firstMismatchIndex({ expected: originalMessages, actual: restoredMessages });

    return {
      status: 'observed',
      fixtureId,
      method,
      modelVisibleProjectionMethod: 'build-chat-generation-messages-v1',
      serializedByteLength: bytes.byteLength,
      serializedSha256: await sha256Hex({ bytes }),
      originalMessages,
      restoredMessages,
      exactModelVisibleMatch: mismatch === undefined,
      firstMismatchIndex: mismatch,
    };
  } catch (error) {
    return {
      status: 'failed',
      fixtureId,
      method,
      error: serializeInvestigationError({ error }),
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
