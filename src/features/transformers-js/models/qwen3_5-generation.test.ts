import { describe, expect, it } from 'vitest';
import { createQwen3_5Generation } from './qwen3_5-generation';
import { parseQwen3_5NativeToolCall } from './qwen3_5-tool-call-parser';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';

const tools: WorkerToolDefinition[] = [{ type: 'function', function: { name: 'f', description: '', parameters: {
  type: 'object', properties: { s: { type: 'string' }, n: { type: 'number' }, o: { type: 'object' } },
} } }];
const enabled = `\
<|im_start|>assistant
<think>
`;
const disabled = `\
<|im_start|>assistant
<think>

</think>

`;
const body = `\
<function=f>
<parameter=s>
  value${'  '}
</parameter>
</function>`;
function setup({ prompt, declarations }: { prompt: string, declarations: WorkerToolDefinition[] | undefined }) {
  const events: InferenceGenerationEvent[] = [];
  const codec = createQwen3_5Generation({ prompt, tools: declarations, emit: ({ event }) => {
    events.push(event);
  } });
  return { codec, events };
}
function content({ events, index }: { events: InferenceGenerationEvent[], index: number }): string {
  return events.flatMap(e => e.type === 'text_delta' && e.index === index ? [e.text] : []).join('');
}
function completeCall({ codec, content }: { codec: ReturnType<typeof createQwen3_5Generation>, content: string }): void {
  codec.control({ token: '<tool_call>' }); codec.text({ text: content }); codec.control({ token: '</tool_call>' });
}

describe('Qwen structured native generation', () => {
  it.each(['whole', 'characters'] as const)('preserves ordinary tag-shaped body and whitespace (%s)', delivery => {
    const { codec, events } = setup({ prompt: disabled, declarations: undefined });
    const text = '<think>literal</think>🙂  \n';
    for (const chunk of delivery === 'whole' ? [text] : [...text]) codec.text({ text: chunk });
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(content({ events, index: 0 })).toBe(text);
    expect(events.filter(e => e.type === 'part_start')).toEqual([{ type: 'part_start', index: 0, kind: 'text' }]);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'user' } });
  });
  it.each(['whole', 'characters'] as const)('uses prefilled reasoning and removes only fixed framing (%s)', delivery => {
    const { codec, events } = setup({ prompt: enabled, declarations: undefined });
    const raw = '  R🙂\n\n';
    for (const chunk of delivery === 'whole' ? [raw] : [...raw]) codec.text({ text: chunk });
    codec.control({ token: '</think>' }); codec.text({ text: '\n' }); codec.text({ text: '\n' }); codec.text({ text: 'A  ' });
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(content({ events, index: 0 })).toBe('  R🙂\n');
    expect(content({ events, index: 1 })).toBe('A  ');
    expect(events.filter(e => e.type === 'part_end')).toEqual([
      { type: 'part_end', index: 0, completeness: 'complete' }, { type: 'part_end', index: 1, completeness: 'complete' },
    ]);
  });
  it('recognizes an explicit native thought opener but preserves separate same-kind parts', () => {
    const { codec, events } = setup({ prompt: disabled, declarations: undefined });
    for (const value of ['R1', 'R2']) {
      codec.control({ token: '<think>' }); codec.text({ text: `\n${value}\n` }); codec.control({ token: '</think>' }); codec.text({ text: '\n\n' });
    }
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'part_start').map(e => e.kind)).toEqual(['reasoning', 'reasoning']);
    expect(content({ events, index: 0 })).toBe('R1'); expect(content({ events, index: 1 })).toBe('R2');
  });
  it('retains a held thought newline when interrupted rather than trimming it', () => {
    const { codec, events } = setup({ prompt: enabled, declarations: undefined });
    codec.text({ text: '途中\n' }); codec.finish({ reason: 'aborted' });
    expect(content({ events, index: 0 })).toBe('途中\n');
    expect(events.at(-2)).toEqual({ type: 'part_end', index: 0, completeness: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'aborted' } });
  });
  it('does not mistake EOS for a closed thought', () => {
    const { codec, events } = setup({ prompt: enabled, declarations: undefined });
    codec.text({ text: 'R\n' }); codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(content({ events, index: 0 })).toBe('R\n');
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'unknown' } });
  });
  it('keeps a partial separator rather than deleting a single unfinished LF', () => {
    const { codec, events } = setup({ prompt: enabled, declarations: undefined });
    codec.text({ text: 'R\n' }); codec.control({ token: '</think>' }); codec.text({ text: '\n' }); codec.finish({ reason: 'limit' });
    expect(content({ events, index: 1 })).toBe('\n');
    expect(events.at(-2)).toMatchObject({ type: 'part_end', completeness: 'partial' });
  });
  it('does not remove body whitespace after a control literal used as reasoning content', () => {
    const { codec, events } = setup({ prompt: disabled, declarations: tools });
    codec.control({ token: '<think>' }); codec.control({ token: '<tool_call>' });
    codec.text({ text: '\nR\n' }); codec.control({ token: '</think>' });
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(content({ events, index: 0 })).toBe(`\
<tool_call>
R`);
  });
  it('does not parse tool controls within reasoning as an executable call', () => {
    const { codec, events } = setup({ prompt: enabled, declarations: tools });
    codec.control({ token: '<tool_call>' }); codec.text({ text: 'example' }); codec.control({ token: '</tool_call>' });
    codec.control({ token: '</think>' }); codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(content({ events, index: 0 })).toBe('<tool_call>example</tool_call>');
    expect(events.some(e => e.type === 'tool_call')).toBe(false);
  });
  it('retains completed calls and ignores only a confirmed native separator between them', () => {
    const { codec, events } = setup({ prompt: disabled, declarations: tools });
    completeCall({ codec, content: body }); codec.text({ text: '\n' }); completeCall({ codec, content: body });
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'tool_call')).toMatchObject([
      { index: 0, toolCall: { function: { name: 'f', arguments: '{"s":"  value  "}' } } },
      { index: 1, toolCall: { function: { name: 'f', arguments: '{"s":"  value  "}' } } },
    ]);
    expect(events.some(e => e.type === 'part_start')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'finished', next: 'tool_results' } });
  });
  it('does not lose completed calls when a later draft stops', () => {
    const { codec, events } = setup({ prompt: disabled, declarations: tools });
    completeCall({ codec, content: body }); codec.control({ token: '<tool_call>' }); codec.text({ text: '<function=f>' });
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'result', result: { type: 'interrupted', reason: 'unknown' } });
  });
  it('requires a real tool close delimiter and refuses an undeclared tool protocol', () => {
    const { codec, events } = setup({ prompt: disabled, declarations: tools });
    codec.control({ token: '<tool_call>' }); codec.text({ text: body }); codec.finish({ reason: 'limit' });
    expect(events.some(e => e.type === 'tool_call')).toBe(false);
    const disabledTools = setup({ prompt: disabled, declarations: undefined });
    expect(() => disabledTools.codec.control({ token: '<tool_call>' })).toThrow(/without tool/);
  });
  it('keeps a tool-shaped native delimiter within a string parameter as argument data', () => {
    const { codec, events } = setup({ prompt: disabled, declarations: tools });
    codec.control({ token: '<tool_call>' }); codec.text({ text: `\
<function=f>
<parameter=s>
` });
    codec.control({ token: '</tool_call>' }); codec.text({ text: `\

</parameter>
</function>` }); codec.control({ token: '</tool_call>' });
    codec.control({ token: '<|im_end|>' }); codec.finish({ reason: 'unknown' });
    expect(events.find(e => e.type === 'tool_call')).toMatchObject({ toolCall: { function: { arguments: '{"s":"</tool_call>"}' } } });
  });
  it('bounds draft buffering and rejects unsupported controls without creating more calls', () => {
    const { codec } = setup({ prompt: disabled, declarations: tools });
    codec.control({ token: '<tool_call>' }); expect(() => codec.text({ text: 'x'.repeat(65 * 1024) })).toThrow(/size limit/);
    const other = setup({ prompt: disabled, declarations: tools });
    expect(() => other.codec.control({ token: '<|im_start|>' })).toThrow(/Unsupported/);
  });
  it('preserves empty native parts but does not fabricate a part on initial cancellation', () => {
    const a = setup({ prompt: enabled, declarations: undefined }); a.codec.finish({ reason: 'aborted' });
    expect(a.events).toEqual([{ type: 'result', result: { type: 'interrupted', reason: 'aborted' } }]);
    const b = setup({ prompt: enabled, declarations: undefined }); b.codec.control({ token: '</think>' }); b.codec.control({ token: '<|im_end|>' }); b.codec.finish({ reason: 'unknown' });
    expect(b.events[0]).toEqual({ type: 'part_start', index: 0, kind: 'reasoning' });
    const c = setup({ prompt: disabled, declarations: undefined }); c.codec.control({ token: '<|im_end|>' }); c.codec.finish({ reason: 'unknown' });
    expect(c.events[0]).toEqual({ type: 'part_start', index: 0, kind: 'text' });
  });
  it('rejects unknown prefixes and late content instead of guessing a thinking mode', () => {
    expect(() => setup({ prompt: '<think>', declarations: undefined })).toThrow(/prefix/);
    expect(() => setup({ prompt: `${enabled} `, declarations: undefined })).toThrow(/prefix/);
    const { codec } = setup({ prompt: disabled, declarations: undefined }); codec.control({ token: '<|im_end|>' });
    expect(() => codec.text({ text: 'late' })).toThrow(/after completion/); codec.finish({ reason: 'unknown' });
    expect(() => codec.finish({ reason: 'unknown' })).toThrow(/twice/);
  });
});

describe('Qwen completed native parameter grammar', () => {
  it('preserves string edge whitespace while decoding schema-backed numeric arguments', () => {
    const value = parseQwen3_5NativeToolCall({ content: `\
<function=f>
<parameter=s>
  x

</parameter>
<parameter=n>
1.25
</parameter>
</function>`, tools });
    expect(value.function.arguments).toBe('{"s":"  x\\n","n":1.25}');
  });
  it.each([
    '<function=f>garbage</function>',
    '<function=f><parameter=s>A</parameter>ignored</function>',
    '<function=f><parameter=s>A</parameter><parameter=s>B</parameter></function>',
    '<function=f><parameter=s>A</function>',
    '{"name":"f","arguments":{}}',
  ])('rejects incomplete, ambiguous, or unsupported body %s', content => {
    expect(() => parseQwen3_5NativeToolCall({ content, tools })).toThrow();
  });
});
