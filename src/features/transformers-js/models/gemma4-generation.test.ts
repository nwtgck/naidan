import { describe, expect, it } from 'vitest';
import { createGemma4Generation } from './gemma4-generation';
import { inferenceGenerationEventSchema, type InferenceGenerationEvent } from '@/features/transformers-js/generation-events';

function setup({ toolCalls }: { toolCalls: 'enabled' | 'disabled' }) {
  const events: InferenceGenerationEvent[] = [];
  const decoder = createGemma4Generation({ toolCalls, emit: ({ event }) => {
    events.push(inferenceGenerationEventSchema.parse(event));
  } });
  return { decoder, events };
}
function textBodies({ events }: { events: InferenceGenerationEvent[] }) {
  return events.filter(e => e.type === 'part_start').map(start => ({
    kind: start.kind,
    text: events.filter(e => e.type === 'text_delta').filter(e => e.index === start.index).map(e => e.text).join(''),
    completeness: events.filter(e => e.type === 'part_end').find(e => e.index === start.index)?.completeness,
  }));
}
function thought({ decoder, text }: { decoder: ReturnType<typeof createGemma4Generation>, text: string }) {
  decoder.control({ token: '<|channel>' });
  decoder.text({ text: 'thought\n' }); decoder.text({ text });
  decoder.control({ token: '<channel|>' });
}
function call({ decoder, body }: { decoder: ReturnType<typeof createGemma4Generation>, body: string }) {
  decoder.control({ token: '<|tool_call>' }); decoder.text({ text: body }); decoder.control({ token: '<tool_call|>' });
}

describe('native Gemma generation parts', () => {
  it('keeps ordinary text and literal protocol spellings without classifying them', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    const literal = `\
<think>R</think><|channel>thought
A<channel|><|tool_call>call:f{}<tool_call|>  `;
    decoder.text({ text: literal }); decoder.control({ token: '<turn|>' }); decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })).toEqual([{ kind: 'text', text: literal, completeness: 'complete' }]);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
    expect(events.filter(e => e.type === 'tool_call')).toEqual([]);
  });
  it.each(['  R\n', 'R\n\n', '', '\n', '\r\n', 'R'])('removes at most the confirmed boundary newline: %j', value => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    thought({ decoder, text: value }); decoder.text({ text: 'A  \n' }); decoder.control({ token: '<turn|>' }); decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })).toEqual([
      { kind: 'reasoning', text: value.endsWith('\n') ? value.slice(0, -1) : value, completeness: 'complete' },
      { kind: 'text', text: 'A  \n', completeness: 'complete' },
    ]);
  });
  it('keeps multiple thought and text intervals as separate parts', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    thought({ decoder, text: 'R1\n' }); decoder.text({ text: 'A1 ' });
    thought({ decoder, text: 'R2\n' }); decoder.text({ text: 'A2 ' }); decoder.control({ token: '<eos>' }); decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events }).map(p => [p.kind, p.text])).toEqual([['reasoning', 'R1'], ['text', 'A1 '], ['reasoning', 'R2'], ['text', 'A2 ']]);
    expect(events.filter(e => e.type === 'part_start').map(e => e.index)).toEqual([0, 1, 2, 3]);
  });
  it('parses a thought header and boundary newline split across every text chunk', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    decoder.control({ token: '<|channel>' });
    for (const text of ['t', 'hou', 'ght', '\n', 'A', '\n', '\n']) decoder.text({ text });
    decoder.control({ token: '<channel|>' }); decoder.control({ token: '<turn|>' }); decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })).toEqual([{ kind: 'reasoning', text: 'A\n', completeness: 'complete' }]);
  });
  it.each(['aborted', 'limit', 'unknown'] as const)('publishes the held newline unchanged on %s', reason => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    decoder.control({ token: '<|channel>' }); decoder.text({ text: `\
thought
  R
` }); decoder.finish({ reason });
    expect(textBodies({ events })).toEqual([{ kind: 'reasoning', text: '  R\n', completeness: 'partial' }]);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason } });
  });
  it('does not declare a part before an incomplete channel header identifies it', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    decoder.control({ token: '<|channel>' }); decoder.text({ text: 'thou' }); decoder.finish({ reason: 'limit' });
    expect(events).toEqual([{ type: 'result', result: { type: 'interrupted', reason: 'limit' } }]);
  });
  it('distinguishes an explicit empty body terminator from no output', () => {
    const empty = setup({ toolCalls: 'disabled' }); empty.decoder.control({ token: '<turn|>' }); empty.decoder.finish({ reason: 'unknown' });
    const stopped = setup({ toolCalls: 'disabled' }); stopped.decoder.finish({ reason: 'aborted' });
    expect(textBodies({ events: empty.events })).toEqual([{ kind: 'text', text: '', completeness: 'complete' }]);
    expect(textBodies({ events: stopped.events })).toEqual([]);
  });
  it('does not execute native call-shaped content in the thought channel', () => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    decoder.control({ token: '<|channel>' }); decoder.text({ text: 'thought\n' });
    call({ decoder, body: 'call:f{}' }); decoder.text({ text: '\n' }); decoder.control({ token: '<channel|>' });
    decoder.text({ text: 'A' }); decoder.control({ token: '<turn|>' }); decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })[0]?.text).toBe('<|tool_call>call:f{}<tool_call|>');
    expect(events.filter(e => e.type === 'tool_call')).toEqual([]);
  });
  it('retains quoted control tokens as body text without prematurely closing a thought', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    decoder.control({ token: '<|channel>' }); decoder.text({ text: 'thought\n' });
    decoder.control({ token: '<|"|>' }); decoder.control({ token: '<channel|>' }); decoder.control({ token: '<turn|>' });
    decoder.control({ token: '<|"|>' }); decoder.text({ text: '\n' }); decoder.control({ token: '<channel|>' });
    decoder.control({ token: '<turn|>' }); decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })).toEqual([{ kind: 'reasoning', text: '<|"|><channel|><turn|><|"|>', completeness: 'complete' }]);
  });
  it('publishes completed calls before a native handoff and does not invent text parts', () => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    thought({ decoder, text: 'R\n' }); call({ decoder, body: 'call:one{x:1,ok:true}' }); call({ decoder, body: 'call:two{}' });
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(2);
    decoder.control({ token: '<|tool_response>' }); decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'tool_start').map(e => e.index)).toEqual([1, 2]);
    const calls = events.filter(e => e.type === 'tool_call');
    expect(calls.map(e => e.toolCall.function)).toEqual([{ name: 'one', arguments: '{"x":1,"ok":true}' }, { name: 'two', arguments: '{}' }]);
    expect(calls[0]?.toolCall.id).not.toBe(calls[1]?.toolCall.id);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'tool_results' } });
  });
  it('treats native control tokens inside a native tool string as argument data', () => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    decoder.control({ token: '<|tool_call>' }); decoder.text({ text: 'call:f{s:' }); decoder.control({ token: '<|"|>' });
    decoder.text({ text: 'a\\n' }); decoder.control({ token: '<tool_call|>' }); decoder.control({ token: '<|tool_call>' });
    decoder.control({ token: '<|"|>' }); decoder.text({ text: '}' }); decoder.control({ token: '<tool_call|>' });
    expect(events.filter(e => e.type === 'tool_call')[0]?.toolCall.function.arguments).toBe(JSON.stringify({ s: 'a\\n<tool_call|><|tool_call>' }));
  });
  it('does not reparse an ordinary quote spelling split across text chunks as native framing', () => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    decoder.control({ token: '<|tool_call>' }); decoder.text({ text: 'call:f{s:' });
    for (const text of ['<|', '"|>', 'value<|"|>}']) decoder.text({ text });
    expect(() => decoder.control({ token: '<tool_call|>' })).toThrow('literal native quote');
    expect(events.filter(e => e.type === 'tool_call')).toEqual([]);
  });
  it.each(['{}', '{x:', '{s:'])('never publishes an unfinished call body %s', suffix => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    decoder.control({ token: '<|tool_call>' }); decoder.text({ text: `call:f${suffix}` }); decoder.finish({ reason: 'limit' });
    expect(events).toEqual([{ type: 'tool_start', index: 0 }, { type: 'result', result: { type: 'interrupted', reason: 'limit' } }]);
  });
  it('retains an earlier completed call when a later draft stops', () => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    call({ decoder, body: 'call:first{}' }); decoder.control({ token: '<|tool_call>' }); decoder.text({ text: 'call:second{}' });
    decoder.finish({ reason: 'aborted' }); expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'aborted' } });
  });
  it('keeps an earlier complete call when a later framed call is invalid', () => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    call({ decoder, body: 'call:first{}' });
    expect(() => call({ decoder, body: 'call:second{x:1,x:2}' })).toThrow();
    decoder.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'tool_call').map(e => e.toolCall.function.name)).toEqual(['first']);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'unknown' } });
  });
  it('flushes held reasoning content when an unsupported native control fails', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    decoder.control({ token: '<|channel>' }); decoder.text({ text: `\
thought
R
` });
    expect(() => decoder.control({ token: '<|turn>' })).toThrow();
    decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })).toEqual([{ kind: 'reasoning', text: 'R\n', completeness: 'partial' }]);
  });
  it.each(['call:f{x:null}', 'call:f{x:9007199254740992}', 'call:f{x:1,x:2}', 'call:f{}call:g{}', 'call:f{'])('rejects invalid or input-incompatible call grammar %s', body => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    expect(() => call({ decoder, body })).toThrow(); expect(events.filter(e => e.type === 'tool_call')).toEqual([]);
  });
  it('bounds only unfinished tool grammar, not ordinary long text', () => {
    const a = setup({ toolCalls: 'enabled' }); a.decoder.control({ token: '<|tool_call>' });
    expect(() => a.decoder.text({ text: 'x'.repeat(65537) })).toThrow('size limit');
    const b = setup({ toolCalls: 'disabled' }); b.decoder.text({ text: 'x'.repeat(65537) }); b.decoder.finish({ reason: 'limit' });
    expect(textBodies({ events: b.events })[0]?.text).toHaveLength(65537);
  });
  it.each(['<|image|>', '<|turn>', '<channel|>', '<tool_call|>', '<|tool_response>', '<tool_response|>'])('does not silently discard unsupported or misplaced control %s', token => {
    const { decoder } = setup({ toolCalls: 'disabled' }); expect(() => decoder.control({ token })).toThrow();
  });
  it('rejects unknown channels instead of mislabelling their contents as reasoning', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' }); decoder.control({ token: '<|channel>' });
    expect(() => decoder.text({ text: `\
other
private` })).toThrow('Unsupported Gemma channel'); expect(events).toEqual([]);
  });
  it('requires a tool declaration before accepting an executable call', () => {
    const { decoder } = setup({ toolCalls: 'disabled' }); expect(() => call({ decoder, body: 'call:f{}' })).toThrow('without tool declarations');
  });
  it.each(['thought', 'tool'] as const)('a turn boundary does not complete an open %s', kind => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    if (kind === 'thought') {
      decoder.control({ token: '<|channel>' }); decoder.text({ text: `\
thought
R
` });
    } else {
      decoder.control({ token: '<|tool_call>' }); decoder.text({ text: 'call:f{}' });
    }
    decoder.control({ token: '<turn|>' }); decoder.finish({ reason: 'unknown' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'unknown' } });
    expect(events.filter(e => e.type === 'tool_call')).toEqual([]);
    if (kind === 'thought') expect(textBodies({ events })).toEqual([{ kind: 'reasoning', text: 'R\n', completeness: 'partial' }]);
  });
  it('accepts the recorded turn-plus-EOS ending as one completion', () => {
    const { decoder, events } = setup({ toolCalls: 'disabled' });
    decoder.text({ text: 'Answer' });
    decoder.control({ token: '<turn|>' });
    decoder.control({ token: '<eos>' });
    decoder.finish({ reason: 'unknown' });
    expect(textBodies({ events })).toEqual([{ kind: 'text', text: 'Answer', completeness: 'complete' }]);
    expect(events.filter(event => event.type === 'result')).toEqual([
      { type: 'result', result: { type: 'finished', next: 'user' } },
    ]);
  });
  it.each(['thought', 'tool'] as const)('keeps an open %s interrupted across redundant end markers', kind => {
    const { decoder, events } = setup({ toolCalls: 'enabled' });
    if (kind === 'thought') {
      decoder.control({ token: '<|channel>' }); decoder.text({ text: `\
thought
R` });
    } else {
      decoder.control({ token: '<|tool_call>' }); decoder.text({ text: 'call:f{}' });
    }
    decoder.control({ token: '<turn|>' });
    decoder.control({ token: '<eos>' });
    decoder.finish({ reason: 'unknown' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'unknown' } });
    expect(events.filter(event => event.type === 'tool_call')).toEqual([]);
  });
  it('rejects further content and repeated completion', () => {
    const { decoder } = setup({ toolCalls: 'disabled' }); decoder.control({ token: '<turn|>' });
    expect(() => decoder.text({ text: 'late' })).toThrow('after completion');
    expect(() => decoder.control({ token: '<|image|>' })).toThrow('after completion');
    decoder.finish({ reason: 'unknown' });
    expect(() => decoder.control({ token: '<eos>' })).toThrow('after completion');
    expect(() => decoder.finish({ reason: 'unknown' })).toThrow('twice');
  });
});
