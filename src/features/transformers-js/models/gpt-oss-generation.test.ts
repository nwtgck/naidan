import { describe, expect, it } from 'vitest';
import { createGptOssGeneration } from './gpt-oss-generation';
import { inferenceGenerationEventSchema, type InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { AssistantMessageNode } from '@/01-models/types';
import { toMessageId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { createInferenceGeneration } from '@/features/transformers-js/create-inference-generation';
import { prepareInferenceRequest } from '@/features/transformers-js/message-projection';

function setup() {
  const events: InferenceGenerationEvent[] = [];
  const decoder = createGptOssGeneration({ emit: ({ event }) => {
    events.push(inferenceGenerationEventSchema.parse(event));
  } });
  return { events, decoder };
}
function message({ decoder, channel, recipient, text, ending }: {
  decoder: ReturnType<typeof createGptOssGeneration>, channel: string,
  recipient: string | undefined, text: string, ending: '<|end|>' | '<|return|>' | '<|call|>' | undefined,
}) {
  decoder.control({ token: '<|start|>' }); decoder.text({ text: `assistant${recipient === undefined ? '' : ` to=${recipient}`}` });
  decoder.control({ token: '<|channel|>' }); decoder.text({ text: channel }); decoder.control({ token: '<|message|>' });
  decoder.text({ text }); if (ending !== undefined) decoder.control({ token: ending });
}

describe('native Harmony generation parts', () => {
  it.each([
    { kind: 'tool only', reasoning: undefined, text: undefined },
    { kind: 'leading reasoning and tool', reasoning: '  R\n', text: undefined },
    { kind: 'explicit empty text and tool', reasoning: undefined, text: '' },
  ])('cache identity matches the delivered parts projection for $kind', async ({ reasoning, text }) => {
    const { decoder, events } = setup();
    const args = ' { "x": 1.00, "escaped": "\\u0041" } ';
    if (reasoning !== undefined) message({ decoder, channel: 'analysis', recipient: undefined, text: reasoning, ending: '<|end|>' });
    if (text !== undefined) message({ decoder, channel: 'commentary', recipient: undefined, text, ending: '<|end|>' });
    message({ decoder, channel: 'commentary', recipient: 'functions.calculator', text: args, ending: '<|call|>' });
    decoder.finish({ reason: 'unknown' });
    const node: AssistantMessageNode = {
      id: toMessageId({ raw: 'cache-history' }), role: 'assistant', createdAt: 1,
      modelId: undefined, lmParameters: undefined, interruption: undefined, parts: [], replies: { items: [] },
    };
    const controller = new AbortController();
    const result = await consumeChatGeneration({ node, abortController: controller, onChange: () => {},
      items: createInferenceGeneration({ signal: controller.signal, generate: async ({ onEvent }) => {
        for (const event of events) await onEvent({ event });
      } }),
    });
    expect(result).toEqual({ type: 'finished', next: 'tool_results' });
    const call = node.parts.find(part => part.type === 'tool_call');
    if (call?.type !== 'tool_call') throw new Error('Missing delivered call.');
    const projected = await prepareInferenceRequest({
      messages: [createChatMessageSnapshot({ node })], parameters: undefined, tools: undefined,
      readBinaryObject: undefined, signal: undefined,
    });
    expect(projected.messages).toEqual([{
      role: 'assistant', content: text ?? [],
      tool_calls: [{ id: call.toolCall.id, type: 'function', function: { name: 'calculator', arguments: args } }],
      ...(reasoning === undefined ? {} : { reasoning: { text: reasoning, completeness: 'complete' } }),
    }]);
    expect(decoder.assistant()).toStrictEqual(projected.messages[0]);
    expect(JSON.stringify(decoder.assistant())).toBe(JSON.stringify(projected.messages[0]));
  });

  it('preserves separate reasoning intervals, commentary, final content and exact whitespace', () => {
    const { events, decoder } = setup();
    for (const [channel, text, ending] of [['analysis', '  R\n', '<|end|>'], ['analysis', '', '<|end|>'], ['commentary', 'Searching. ', '<|end|>'], ['final', 'Answer  ', '<|return|>']] as const) {
      message({ decoder, channel, text, ending, recipient: undefined });
    }
    decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start').map(e => e.kind)).toEqual(['reasoning', 'reasoning', 'text', 'text']);
    expect(events.filter(e => e.type === 'text_delta').map(e => e.text)).toEqual(['  R\n', 'Searching. ', 'Answer  ']);
    expect(events.filter(e => e.type === 'part_end').map(e => e.completeness)).toEqual(['complete', 'complete', 'complete', 'complete']);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
    expect(decoder.assistant()).toBeUndefined();
  });
  it('does not interpret literal think tags or a spelled Harmony control in ordinary text', () => {
    const { events, decoder } = setup();
    message({ decoder, channel: 'final', recipient: undefined, text: '<think>R</think><|return|>', ending: '<|return|>' });
    decoder.finish({ reason: 'unknown' });
    expect(events[1]).toEqual({ type: 'text_delta', index: 0, text: '<think>R</think><|return|>' });
    expect(decoder.assistant()?.content).toBe('<think>R</think><|return|>');
  });
  it('keeps a stopped reasoning partial without inventing closing text', () => {
    const { decoder, events } = setup();
    message({ decoder, channel: 'analysis', recipient: undefined, text: '  R', ending: undefined });
    decoder.finish({ reason: 'aborted' });
    expect(events).toEqual([
      { type: 'part_start', index: 0, kind: 'reasoning' }, { type: 'text_delta', index: 0, text: '  R' },
      { type: 'part_end', index: 0, completeness: 'partial' }, { type: 'result', result: { type: 'interrupted', reason: 'aborted' } },
    ]);
    expect(decoder.assistant()).toBeUndefined();
  });
  it('does not turn a closed analysis message without a turn terminator into a completed response', () => {
    const { decoder, events } = setup();
    message({ decoder, channel: 'analysis', recipient: undefined, text: 'R', ending: '<|end|>' });
    decoder.finish({ reason: 'limit' });
    expect(events.at(-2)).toEqual({ type: 'part_end', index: 0, completeness: 'complete' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'limit' } });
  });
  it('does not publish an empty part before a body header exists', () => {
    const { decoder, events } = setup(); decoder.control({ token: '<|channel|>' }); decoder.text({ text: 'analy' }); decoder.finish({ reason: 'unknown' });
    expect(events).toEqual([{ type: 'result', result: { type: 'interrupted', reason: 'unknown' } }]);
  });
  it('publishes completed calls at the native handoff and preserves the argument spelling', () => {
    const { decoder, events } = setup(); const args = ' { "x": 1e2, "escaped": "\\u0041" } ';
    message({ decoder, channel: 'analysis', recipient: undefined, text: 'R', ending: '<|end|>' });
    message({ decoder, channel: 'commentary', recipient: 'functions.calculator', text: args, ending: '<|call|>' });
    decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'tool_start')).toEqual([{ type: 'tool_start', index: 1 }]);
    expect(events.filter(e => e.type === 'tool_call')).toEqual([expect.objectContaining({ index: 1, toolCall: expect.objectContaining({ function: { name: 'calculator', arguments: args } }) })]);
    expect(decoder.assistant()).toEqual({ role: 'assistant', content: [], reasoning: { text: 'R', completeness: 'complete' }, tool_calls: [expect.objectContaining({ function: { name: 'calculator', arguments: args } })] });
  });
  it.each(['{}', '{"unfinished":'])('never publishes a call draft at EOF: %s', args => {
    const { decoder, events } = setup();
    message({ decoder, channel: 'commentary', recipient: 'functions.f', text: args, ending: undefined });
    decoder.finish({ reason: 'limit' });
    expect(events).toEqual([{ type: 'tool_start', index: 0 }, { type: 'result', result: { type: 'interrupted', reason: 'limit' } }]);
    expect(decoder.assistant()).toBeUndefined();
  });
  it.each(['other', 'confidence'])('does not silently treat an unsupported channel as text: %s', channel => {
    const { decoder, events } = setup();
    expect(() => message({ decoder, channel, recipient: undefined, text: 'x', ending: undefined })).toThrow('Unsupported Harmony channel');
    expect(events).toEqual([]);
  });
  it('keeps previous completed content when a malformed call fails validation', () => {
    const { decoder, events } = setup();
    message({ decoder, channel: 'analysis', recipient: undefined, text: 'R', ending: '<|end|>' });
    expect(() => message({ decoder, channel: 'commentary', recipient: 'functions.f', text: '{"x":', ending: '<|call|>' })).toThrow();
    expect(events.filter(e => e.type === 'tool_call')).toEqual([]);
    expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', index: 0, text: 'R' }]);
  });
  it('rejects further output and duplicate settlement after a confirmed turn boundary', () => {
    const { decoder } = setup();
    message({ decoder, channel: 'final', recipient: undefined, text: '', ending: '<|return|>' });
    expect(() => decoder.text({ text: 'later' })).toThrow('after completion');
    decoder.finish({ reason: 'unknown' }); expect(() => decoder.finish({ reason: 'unknown' })).toThrow('twice');
  });
  it('does not flatten multiple native text bodies into a cache-history identity', () => {
    const { decoder, events } = setup();
    message({ decoder, channel: 'commentary', recipient: undefined, text: 'A', ending: '<|end|>' });
    message({ decoder, channel: 'commentary', recipient: undefined, text: 'B', ending: '<|end|>' });
    message({ decoder, channel: 'commentary', recipient: 'functions.f', text: '{}', ending: '<|call|>' });
    decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start')).toHaveLength(2);
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(decoder.assistant()).toBeUndefined();
  });
  it('does not retain a reasoning-plus-text-plus-call identity the input codec cannot replay', () => {
    const { decoder, events } = setup();
    message({ decoder, channel: 'analysis', recipient: undefined, text: 'R', ending: '<|end|>' });
    message({ decoder, channel: 'commentary', recipient: undefined, text: '', ending: '<|end|>' });
    message({ decoder, channel: 'commentary', recipient: 'functions.f', text: '{}', ending: '<|call|>' });
    decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start').map(e => e.kind)).toEqual(['reasoning', 'text']);
    expect(decoder.assistant()).toBeUndefined();
  });

});
