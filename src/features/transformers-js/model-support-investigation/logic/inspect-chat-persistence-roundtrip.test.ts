import { afterEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '@/00-storage/service/chat-content-serialization';
import { inspectChatPersistenceRoundTrip } from '@/features/transformers-js/model-support-investigation/logic/inspect-chat-persistence-roundtrip';

afterEach(() => vi.restoreAllMocks());

describe('inspectChatPersistenceRoundTrip', () => {
  it('preserves model-visible tool history through the production DTO JSON contract', async () => {
    const result = await inspectChatPersistenceRoundTrip();
    expect(result.status).toBe('observed');
    if (result.status !== 'observed') throw new Error(result.error.message);
    expect(result.fixtureId).toBe('parts_history_v2');
    expect(result.method).toBe('chat_content_parts_json_roundtrip_v2');
    expect(result.modelVisibleProjectionMethod).toBe('build_chat_generation_messages_parts_v2');
    expect(result.serializedByteLength).toBeGreaterThan(0);
    expect(result.serializedSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.exactModelVisibleMatch).toBe(true);
    expect(result.firstMismatchIndex).toBeUndefined();
    expect(result.restoredMessages).toEqual(result.originalMessages);
    expect(result.restoredMessages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    const assistant = result.restoredMessages.find(message => message.role === 'assistant');
    expect(assistant).toEqual({
      id: 'model-support-investigation-assistant', role: 'assistant',
      parts: [
        { id: 'reasoning', type: 'reasoning', text: `\
  Check the forecast.
`, completeness: 'complete' },
        { id: 'empty', type: 'text', text: '', completeness: 'complete' },
        { id: 'literal', type: 'text', text: '<think>preserve this exact model-visible tool-call prefix</think>', completeness: 'complete' },
        { id: 'call', type: 'tool_call', toolCall: {
          id: 'model-support-investigation-tool-call-1', type: 'function',
          function: { name: 'lookup_weather', arguments: `\
{
  "city": "Tokyo",
  "unit": "C"
}` },
        } },
      ],
    });
    const tool = result.restoredMessages.find(message => message.role === 'tool');
    expect(tool).toEqual({
      id: 'model-support-investigation-tool-result', role: 'tool',
      parts: [{ id: 'result', type: 'tool_result', result: {
        toolCallId: 'model-support-investigation-tool-call-1', status: 'success',
        content: { type: 'text', text: `\
{"temperatureC":20,"condition":"clear"}
source=fixture` },
      } }],
    });
    expect(result.restoredMessages[4]?.parts).toEqual([{ id: 'partial', type: 'text', text: `\
  Tokyo 🙂
`, completeness: 'partial' }]);
  });

  it('produces deterministic fixed evidence without fetching or mutating a storage provider', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network access'));
    const first = await inspectChatPersistenceRoundTrip();
    const second = await inspectChatPersistenceRoundTrip();
    expect(first.status).toBe('observed');
    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
    if (first.status !== 'observed' || second.status !== 'observed') throw new Error('Missing evidence');
    expect(second.originalMessages).not.toBe(first.originalMessages);
    expect(first.originalMessages).not.toBe(first.restoredMessages);
    expect(first.originalMessages[2]?.parts).not.toBe(first.restoredMessages[2]?.parts);
  });

  it('reports a changed restored part rather than making the expectation from the changed output', async () => {
    const originalRoundTrip = persistence.roundTripChatContentPersistenceSerialization;
    vi.spyOn(persistence, 'roundTripChatContentPersistenceSerialization').mockImplementation(({ content }) => {
      const result = originalRoundTrip({ content });
      const first = result.restored.root.items[0]?.parts[0];
      if (first?.type !== 'text') throw new Error('Expected fixed system text');
      first.text += 'changed';
      return result;
    });
    const result = await inspectChatPersistenceRoundTrip();
    expect(result.status).toBe('observed');
    if (result.status !== 'observed') throw new Error(result.error.message);
    expect(result.exactModelVisibleMatch).toBe(false);
    expect(result.firstMismatchIndex).toBe(0);
    expect(result.originalMessages[0]?.parts[0]).toMatchObject({ text: 'Keep the supplied history unchanged.' });
    expect(result.restoredMessages[0]?.parts[0]).toMatchObject({ text: 'Keep the supplied history unchanged.changed' });
  });

  it('identifies a current-format failure without fabricating a legacy observation', async () => {
    vi.spyOn(persistence, 'roundTripChatContentPersistenceSerialization').mockImplementation(() => {
      throw new Error('Bearer secret-value');
    });
    const result = await inspectChatPersistenceRoundTrip();
    expect(result).toMatchObject({
      status: 'failed', fixtureId: 'parts_history_v2', method: 'chat_content_parts_json_roundtrip_v2',
      error: { name: 'Error', message: 'Bearer [REDACTED]' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
  });
});
