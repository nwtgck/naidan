import { describe, expect, it, vi } from 'vitest';
import { createStandardGeneration, resolveStandardGenerationFraming } from './standard-generation';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import type { StandardToolHandling } from '@/features/transformers-js/standard-tool-call-protocol';

const handling: StandardToolHandling = { outputProtocol: 'delimited-pythonic', historyEncoding: 'native-template', preservedDelimiterIds: [] };
const tools: WorkerToolDefinition[] = [{ type: 'function', function: { name: 'f', description: '', parameters: { type: 'object' } } }];
const open = '<|tool_call_start|>';
const close = '<|tool_call_end|>';
function setup({ declarations, history }: { declarations: WorkerToolDefinition[] | undefined, history: StandardToolHandling['historyEncoding'] }) {
  const events: InferenceGenerationEvent[] = [];
  const codec = createStandardGeneration({ emit: ({ event }) => {
    events.push(event);
  }, endTokens: ['<eos>'], handling: { ...handling, historyEncoding: history }, tools: declarations });
  return { codec, events };
}
function strings({ events }: { events: InferenceGenerationEvent[] }): string {
  return events.flatMap(event => event.type === 'text_delta' ? [event.text] : []).join('');
}
function feedCall({ codec, body }: { codec: ReturnType<typeof createStandardGeneration>, body: string }): void {
  codec.control({ token: open }); codec.text({ text: body }); codec.control({ token: close });
}

describe('standard structured native generation', () => {
  it.each(['whole', 'characters'] as const)('preserves ordinary marker-looking text without classifying it (%s)', delivery => {
    const { codec, events } = setup({ declarations: undefined, history: 'native-template' });
    const raw = `  <think>literal</think>${open}[f()]${close}🙂\r\n  `;
    for (const text of delivery === 'whole' ? [raw] : [...raw]) codec.text({ text });
    codec.control({ token: '<eos>' }); codec.finish({ reason: 'unknown' });
    expect(strings({ events })).toBe(raw);
    expect(events.filter(e => e.type === 'part_start')).toEqual([{ type: 'part_start', index: 0, kind: 'text' }]);
    expect(events.at(-2)).toEqual({ type: 'part_end', index: 0, completeness: 'complete' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
  });
  it('represents an explicit empty answer only when a native end arrives', () => {
    const complete = setup({ declarations: undefined, history: 'native-template' });
    complete.codec.control({ token: '<eos>' }); complete.codec.finish({ reason: 'unknown' });
    expect(complete.events).toHaveLength(3);
    const missing = setup({ declarations: undefined, history: 'native-template' });
    missing.codec.finish({ reason: 'aborted' });
    expect(missing.events).toEqual([{ type: 'result', result: { type: 'interrupted', reason: 'aborted' } }]);
  });
  it.each(['aborted', 'limit', 'unknown'] as const)('retains accepted text as partial without native EOS (%s)', reason => {
    const { codec, events } = setup({ declarations: undefined, history: 'native-template' });
    codec.text({ text: '途中\n ' }); codec.finish({ reason });
    expect(strings({ events })).toBe('途中\n ');
    expect(events.at(-2)).toMatchObject({ type: 'part_end', completeness: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason } });
  });
  it('does not strip unknown real channel or role controls and call it successful', () => {
    const { codec, events } = setup({ declarations: undefined, history: 'native-template' });
    codec.text({ text: 'A' });
    expect(() => codec.control({ token: '<think>' })).toThrow(/model-specific/);
    codec.finish({ reason: 'unknown' });
    expect(strings({ events })).toBe('A'); expect(events.at(-1)).toMatchObject({ result: { type: 'interrupted' } });
  });
  it('rejects content and a second finish after settlement', () => {
    const { codec } = setup({ declarations: undefined, history: 'native-template' });
    codec.control({ token: '<eos>' });
    expect(() => codec.text({ text: 'A' })).toThrow(/settlement/);
    codec.finish({ reason: 'unknown' }); expect(() => codec.finish({ reason: 'unknown' })).toThrow(/twice/);
  });
  it('requires a real tool close before publishing complete calls', () => {
    const { codec, events } = setup({ declarations: tools, history: 'native-template' });
    codec.text({ text: 'checking ' }); codec.control({ token: open });
    codec.text({ text: '[f(value=" a ")]' });
    expect(events.some(e => e.type === 'tool_call')).toBe(false);
    codec.control({ token: close }); codec.control({ token: '<eos>' }); codec.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'tool_call')).toMatchObject([{ index: 1, toolCall: { type: 'function', function: { name: 'f', arguments: '{"value":" a "}' } } }]);
    expect(events.at(-1)).toMatchObject({ result: { type: 'finished', next: 'tool_results' } });
  });
  it('retains native argument values and every completed call in a block', () => {
    const { codec, events } = setup({ declarations: tools, history: 'native-template' });
    feedCall({ codec, body: '[f(a="🙂", list=[true, null, 1.5]), f(b="two")]' });
    codec.control({ token: '<eos>' }); codec.finish({ reason: 'unknown' });
    const calls = events.flatMap(e => e.type === 'tool_call' ? [e] : []);
    expect(calls.map(e => e.index)).toEqual([0, 1]);
    expect(calls[0]!.toolCall.id).not.toBe(calls[1]!.toolCall.id);
    expect(calls.map(e => JSON.parse(e.toolCall.function.arguments))).toEqual([{ a: '🙂', list: [true, null, 1.5] }, { b: 'two' }]);
  });
  it.each(['eof', 'native_end'] as const)('retains earlier calls when the last draft is interrupted (%s)', ending => {
    const { codec, events } = setup({ declarations: tools, history: 'native-template' });
    feedCall({ codec, body: '[f()]' }); codec.control({ token: open }); codec.text({ text: '[f(' });
    if (ending === 'native_end') codec.control({ token: '<eos>' });
    codec.finish({ reason: 'limit' });
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ result: { type: 'interrupted', reason: 'limit' } });
  });
  it('refuses unknown, invalid, empty, oversized and nested tool frames', () => {
    for (const body of ['[missing()]', '[f(', '[]']) {
      const { codec } = setup({ declarations: tools, history: 'native-template' });
      expect(() => feedCall({ codec, body })).toThrow(/Invalid/);
    }
    const { codec } = setup({ declarations: tools, history: 'native-template' });
    codec.control({ token: open });
    expect(() => codec.text({ text: 'x'.repeat(65537) })).toThrow(/size limit/);
    expect(() => codec.control({ token: open })).toThrow(/nest/);
    const noTools = setup({ declarations: undefined, history: 'native-template' });
    expect(() => noTools.codec.control({ token: open })).toThrow(/declarations/);
  });
  it('preserves post-call text but refuses automatic tool execution for an unsupported input order', () => {
    const { codec, events } = setup({ declarations: tools, history: 'native-template' });
    feedCall({ codec, body: '[f()]' });
    codec.text({ text: ' trailing answer\n' }); codec.control({ token: '<eos>' });
    expect(() => codec.finish({ reason: 'unknown' })).toThrow(/text after a tool call/);
    expect(strings({ events })).toBe(' trailing answer\n');
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'part_end', completeness: 'complete' });
    expect(events.some(e => e.type === 'result')).toBe(false);
  });
  it('can retain an interrupted post-call part without changing the original order', () => {
    const { codec, events } = setup({ declarations: tools, history: 'verified-content' });
    feedCall({ codec, body: '[f()]' }); codec.text({ text: ' unfinished' }); codec.finish({ reason: 'aborted' });
    expect(strings({ events })).toBe(' unfinished');
    expect(events.at(-2)).toMatchObject({ type: 'part_end', index: 1, completeness: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'aborted' } });
  });
  it('enforces the verified-content history limit before publishing the extra call', () => {
    const { codec, events } = setup({ declarations: tools, history: 'verified-content' });
    feedCall({ codec, body: '[f()]' });
    expect(() => feedCall({ codec, body: '[f()]' })).toThrow(/multiple/);
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    codec.finish({ reason: 'unknown' }); expect(events.at(-1)).toMatchObject({ result: { type: 'interrupted' } });
  });
});

describe('native terminator framing', () => {
  function framing({ eos, declarations, protocol }: { eos: unknown, declarations: WorkerToolDefinition[] | undefined, protocol: StandardToolHandling['outputProtocol'] }) {
    const table = new Map([['<eos>', 2], [open, 3], [close, 4]]);
    const prepare = vi.fn(() => ({ eos_token_id: eos }));
    const model = { _prepare_generation_config: prepare } as unknown as Parameters<typeof resolveStandardGenerationFraming>[0]['model'];
    const tokenizer = { unk_token_id: 0, encode: (text: string) => [table.get(text) ?? 0], decode: (ids: number[]) => [...table].find(([, id]) => id === ids[0])?.[0] ?? '' } as unknown as Parameters<typeof resolveStandardGenerationFraming>[0]['tokenizer'];
    const inputs = { input_ids: 'same input' };
    return { invoke: () => resolveStandardGenerationFraming({ model, tokenizer, inputs, handling: { ...handling, outputProtocol: protocol }, tools: declarations }), prepare, inputs };
  }
  it('reads the effective native configuration rather than guessing a tokenizer EOS', () => {
    const f = framing({ eos: [2, 2], declarations: tools, protocol: 'delimited-pythonic' });
    expect(f.invoke()).toEqual({ endTokens: ['<eos>'], protocolTokens: ['<eos>', open, close] });
    expect(f.prepare).toHaveBeenCalledWith(null, f.inputs);
  });
  it('does not invent an EOS when generation has no configured stop token', () => {
    expect(framing({ eos: null, declarations: undefined, protocol: 'json-tagged' }).invoke()).toEqual({ endTokens: [], protocolTokens: [] });
  });
  it('rejects invalid or ambiguous EOS IDs', () => {
    for (const eos of [-1, 1.1, NaN, '2', 999]) expect(framing({ eos, declarations: undefined, protocol: 'json-tagged' }).invoke).toThrow();
  });
  it('does not admit guessed JSON framing or use a tool delimiter as EOS', () => {
    expect(framing({ eos: 2, declarations: tools, protocol: 'json-tagged' }).invoke).toThrow(/adapter/);
    expect(framing({ eos: 3, declarations: tools, protocol: 'delimited-pythonic' }).invoke).toThrow(/terminator/);
  });
});
