import type { ChatContent, MessageNode } from '@/01-models/types';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { roundTripChatContentPersistenceSerialization } from '@/00-storage/service/chat-content-serialization';
import type { ModelSupportInvestigationPersistencePartsRoundTrip } from '@/features/transformers-js/model-support-investigation/types';
import { serializeInvestigationError } from '@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error';
import {
  firstPersistencePartsMismatch,
  recordPersistencePartsMessages,
} from '@/features/transformers-js/model-support-investigation/logic/persistence-parts-evidence';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';

const fixtureId = 'parts_history_v2' as const;
const method = 'chat_content_parts_json_roundtrip_v2' as const;

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const stableBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stableBytes.buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function fixedFixture(): ChatContent {
  const toolCallId = toToolCallId({ raw: 'model-support-investigation-tool-call-1' });
  const nodes: MessageNode[] = [
    {
      id: toMessageId({ raw: 'model-support-investigation-system' }), role: 'system', createdAt: 0,
      modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'system', type: 'text', text: 'Keep the supplied history unchanged.', completeness: 'complete' }],
      replies: { items: [] },
    },
    {
      id: toMessageId({ raw: 'model-support-investigation-user' }), role: 'user', createdAt: 1,
      modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'user', type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' }],
      replies: { items: [] },
    },
    {
      id: toMessageId({ raw: 'model-support-investigation-assistant' }), role: 'assistant', createdAt: 2,
      modelId: undefined, lmParameters: undefined, interruption: undefined,
      parts: [
        { id: 'reasoning', type: 'reasoning', text: `\
  Check the forecast.\n`, completeness: 'complete' },
        { id: 'empty', type: 'text', text: '', completeness: 'complete' },
        { id: 'literal', type: 'text', text: '<think>preserve this exact model-visible tool-call prefix</think>', completeness: 'complete' },
        { id: 'call', type: 'tool_call', toolCall: { id: toolCallId, type: 'function', function: { name: 'lookup_weather', arguments: `\
{
  "city": "Tokyo",
  "unit": "C"
}` } } },
      ],
      replies: { items: [] },
    },
    {
      id: toMessageId({ raw: 'model-support-investigation-tool-result' }), role: 'tool', createdAt: 3,
      modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'result', type: 'tool_result', result: { toolCallId, status: 'success', content: { type: 'text', text: `\
{"temperatureC":20,"condition":"clear"}
source=fixture` } } }],
      replies: { items: [] },
    },
    {
      id: toMessageId({ raw: 'model-support-investigation-partial' }), role: 'assistant', createdAt: 4,
      modelId: undefined, lmParameters: undefined, interruption: { type: 'cancelled' },
      parts: [{ id: 'partial', type: 'text', text: `\
  Tokyo 🙂\n`, completeness: 'partial' }],
      replies: { items: [] },
    },
    {
      id: toMessageId({ raw: 'model-support-investigation-follow-up' }), role: 'user', createdAt: 5,
      modelId: undefined, lmParameters: undefined,
      parts: [{ id: 'follow-up', type: 'text', text: 'Use the tool result in a new answer.', completeness: 'complete' }],
      replies: { items: [] },
    },
  ];
  for (let index = 1; index < nodes.length; index += 1) {
    nodes[index - 1]!.replies.items.push(nodes[index]!);
  }
  return { currentLeafId: nodes.at(-1)!.id, root: { items: [nodes[0]!] } };
}

function projectPersistenceFixture({ content }: { content: ChatContent }) {
  return recordPersistencePartsMessages({ messages: buildChatGenerationMessages({
    chat: content, excludedMessageId: undefined, systemPromptMessages: [],
  }) });
}

export async function inspectChatPersistenceRoundTrip(): Promise<ModelSupportInvestigationPersistencePartsRoundTrip> {
  try {
    const original = fixedFixture();
    const originalMessages = projectPersistenceFixture({ content: original });
    const { restored, serialized } = roundTripChatContentPersistenceSerialization({ content: original });
    const bytes = new TextEncoder().encode(serialized);
    const restoredMessages = projectPersistenceFixture({ content: restored });
    const mismatch = firstPersistencePartsMismatch({ expected: originalMessages, actual: restoredMessages });

    return {
      status: 'observed', fixtureId, method,
      modelVisibleProjectionMethod: 'build_chat_generation_messages_parts_v2',
      serializedByteLength: bytes.byteLength,
      serializedSha256: await sha256Hex({ bytes }),
      originalMessages, restoredMessages,
      exactModelVisibleMatch: mismatch === undefined,
      firstMismatchIndex: mismatch,
    };
  } catch (error) {
    return { status: 'failed', fixtureId, method, error: serializeInvestigationError({ error }) };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
