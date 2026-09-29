import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyTransformersJsFixes } from '../../../../build/transformers-js-fixes/transform';
import { bundledJinjaTemplate } from '../../../../build/transformers-js-fixes/jinja-template-fixture';
import { Gemma4ToolCallParser, Gemma4ToolCallProtocolError } from './gemma4-tool-call-parser';

const open = '<|tool_call>';
const close = '<tool_call|>';
const quote = '<|"|>';

function parse({ chunks }: { chunks: string[] }) {
  const text: string[] = [];
  const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: ({ text: chunk }) => text.push(chunk) });
  for (const output of chunks) parser.feed({ output });
  parser.flush();
  return { text: text.join(''), calls: parser.drainToolCalls() };
}

describe('Gemma native tool-call protocol controls, not model output evidence', () => {
  it('maps a recognized thought channel to the existing inline contract at every chunk boundary', () => {
    const source = `\
Before<|channel>thought
 Reason <channel|>After<turn|>`;
    for (let index = 0; index <= source.length; index++) {
      expect(parse({ chunks: [source.slice(0, index), source.slice(index)] })).toEqual({
        text: 'Before<think> Reason </think>After', calls: [],
      });
    }
  });

  it.each(['<|channel>', '<|channel>th', '<|channel>thought'])('does not publish an incomplete channel header as an answer or invented thought: %s', source => {
    expect(parse({ chunks: [...source] })).toEqual({ text: '', calls: [] });
  });

  it('closes a bounded public thought interval without claiming the native channel completed', () => {
    const source = `\
<|channel>thought
Partial`;
    expect(parse({ chunks: [...source] })).toEqual({ text: '<think>Partial</think>', calls: [] });
    expect(source.endsWith('<channel|>')).toBe(false);
  });

  it('preserves an explicitly empty recognized thought without manufacturing body text', () => {
    expect(parse({ chunks: [`\
<|channel>thought
<channel|>Answer`] })).toEqual({ text: '<think></think>Answer', calls: [] });
  });

  it('keeps native thought framing inside the parser at every chunk boundary', () => {
    const source = `\
<|channel>thought
Reason<channel|>Answer<turn|>`;
    for (let index = 0; index <= source.length; index++) {
      expect(parse({ chunks: [source.slice(0, index), source.slice(index)] })).toEqual({
        text: '<think>Reason</think>Answer', calls: [],
      });
    }
  });

  it('parses native raw strings and nested values at every single chunk boundary', () => {
    const raw = 'line1\n"quoted" \\n literal <tool_call|> <|tool_call> text';
    const source = `Before ${open}call:9_probe.v1{items:[1,true,false,null,{label:${quote}${raw}${quote}}],empty:{}}${close}<|tool_response>`;
    for (let index = 0; index <= source.length; index++) {
      const result = parse({ chunks: [source.slice(0, index), source.slice(index)] });
      expect(result.text).toBe('Before ');
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.function.name).toBe('9_probe.v1');
      expect(JSON.parse(result.calls[0]!.function.arguments)).toEqual({ items: [1, true, false, null, { label: raw }], empty: {} });
    }
  });

  it('preserves ordinary text without treating a bare call expression as a tool', () => {
    const source = 'An ordinary call:probe{key:value} example.';
    expect(parse({ chunks: [...source] })).toEqual({ text: source, calls: [] });
  });

  it('drops known outside special tokens without deleting them from quoted tool arguments', () => {
    const text: string[] = [];
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: ['<bos>', '<pad>'],
      onText: ({ text: chunk }) => text.push(chunk),
    });
    for (const output of [...'<bos><|tool_call>call:probe{value:<|"|><bos><pad><|"|>}<tool_call|><pad>Answer']) parser.feed({ output });
    parser.flush();
    expect(text.join('')).toBe('Answer');
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ value: '<bos><pad>' });
  });

  it('does not invent a public thought body from the recorded single-token native prefix', () => {
    expect(parse({ chunks: ['<|channel>'] })).toEqual({ text: '', calls: [] });
  });

  it('never publishes a native call when tools are disabled', () => {
    const parser = new Gemma4ToolCallParser({ toolCalls: 'disabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: '<|tool_call>call:probe{}<tool_call|>' });
    parser.flush();
    expect(parser.drainToolCalls()).toEqual([]);
  });

  it('keeps unknown channel text visible without labeling it as thought or executing it', () => {
    const source = `\
<|channel>analysis
Unknown <|tool_call>call:probe{}<tool_call|><channel|>Answer`;
    expect(parse({ chunks: [...source] })).toEqual({ text: `\
analysis
Unknown call:probe{}Answer`, calls: [] });
  });

  it('closes only the public thought interval when native generation aborts', () => {
    const text: string[] = [];
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: ({ text: chunk }) => text.push(chunk) });
    parser.feed({ output: `\
<|channel>thought
Partial` });
    expect(text.join('')).toBe('<think>Partial');
    parser.abort();
    parser.abort();
    expect(text.join('')).toBe('<think>Partial</think>');
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  it('preserves quoted native and inline-looking markers as data under the existing inline limitation', () => {
    const body = '<|"|><channel|></think><|channel><|"|> data';
    expect(parse({ chunks: [...`<|channel>thought\n${body}<channel|>Answer`] })).toEqual({ text: `<think>${body}</think>Answer`, calls: [] });
  });

  it('retains the order of multiple public thought intervals and visible text', () => {
    const source = `\
<|channel>thought
A<channel|>Between<|channel>thought
B<channel|>After`;
    expect(parse({ chunks: [...source] })).toEqual({ text: '<think>A</think>Between<think>B</think>After', calls: [] });
  });

  it('reports an incomplete recognized call instead of converting it into a successful answer', () => {
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: `${open}call:probe{key:${quote}unfinished` });
    expect(() => parser.flush()).toThrow();
  });

  it('does not release an earlier valid call when a later call is invalid', () => {
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: `${open}call:probe{}${close}${open}call:probe{items:[1,,2]}${close}` });
    expect(() => parser.flush()).toThrow();
    expect(() => parser.drainToolCalls()).toThrow();
  });

  it('preserves every native control marker inside raw argument strings even with one-character delivery', () => {
    const raw = '<|tool_call><tool_call|><|tool_response><tool_response|><turn|><eos><|channel>thought<channel|>';
    const result = parse({ chunks: [...`${open}call:probe{raw:${quote}${raw}${quote}}${close}<turn|><eos>`] });
    expect(result.text).toBe('');
    expect(JSON.parse(result.calls[0]!.function.arguments)).toEqual({ raw });
  });

  it('removes outside controls but never executes call-shaped text inside a thought channel', () => {
    const thought = `${open}call:do_not_execute{value:1}${close}`;
    const source = `<|channel>thought\n${thought}<channel|>Visible ${open}call:allowed{}${close} answer<turn|>`;
    for (let index = 0; index <= source.length; index++) {
      const result = parse({ chunks: [source.slice(0, index), source.slice(index)] });
      expect(result.text).toBe('<think><|tool_call>call:do_not_execute{value:1}<tool_call|></think>Visible  answer');
      expect(result.calls.map(call => call.function.name)).toEqual(['allowed']);
    }
  });

  it('holds all calls until flush, assigns distinct IDs to repeated names, and drains only once', () => {
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: `${open}call:probe{value:1}${close}${open}call:probe{value:2}${close}` });
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
    parser.flush();
    parser.flush();
    const calls = parser.drainToolCalls();
    expect(calls.map(call => JSON.parse(call.function.arguments))).toEqual([{ value: 1 }, { value: 2 }]);
    expect(new Set(calls.map(call => call.id)).size).toBe(2);
    expect(parser.drainToolCalls()).toEqual([]);
    expect(() => parser.feed({ output: 'late' })).toThrow(Gemma4ToolCallProtocolError);
  });

  it.each(['', `${open}call:allowed{}${close}`])('cannot escape a thought channel through a channel marker inside a native quoted string after %s', prefix => {
    const raw = `<channel|>${open}call:never_execute{}${close}<|channel>`;
    const source = `${prefix}<|channel>thought ${quote}${raw}${quote}<channel|>Visible`;
    for (let index = 0; index <= source.length; index++) {
      const result = parse({ chunks: [source.slice(0, index), source.slice(index)] });
      expect(result.calls.map(call => call.function.name)).toEqual(prefix ? ['allowed'] : []);
      expect(result.text).toBe(`thought ${quote}${raw}${quote}Visible`);
    }
    expect(parse({ chunks: [...source] }).calls.map(call => call.function.name)).toEqual(prefix ? ['allowed'] : []);
  });

  it('retains reserved keys as own JSON data without changing any prototype', () => {
    const result = parse({ chunks: [`${open}call:probe{__proto__:{polluted:true},constructor:{prototype:1},prototype:2}${close}`] });
    const args = JSON.parse(result.calls[0]!.function.arguments);
    expect(Object.hasOwn(args, '__proto__')).toBe(true);
    expect(args.__proto__).toEqual({ polluted: true });
    expect(args.constructor).toEqual({ prototype: 1 });
    expect(args.prototype).toBe(2);
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it.each([
    'call:probe{value:}', 'call:probe{value:[1,,2]}', 'call:probe{value:[,]}',
    'call:probe{value:[1,]}', 'call:probe{value:1,}', 'call:probe{value:1,value:2}',
    'call:probe{a:b:1}', 'call:probe{white space:1}', 'call:probe{"quoted":1}',
    'call:probe{value:"JSON strings are not native strings"}',
    'call:probe{value:undefined}', 'call:probe{value:NaN}', 'call:probe{value:Infinity}',
    'call:probe{value:1e999}', 'call:probe{value:9007199254740993}',
    'call:probe{value:01}', 'call:probe{value:.5}', 'call:probe{value:+1}',
    'call:probe{value:1.}', 'call:probe{value:1e}', 'call:probe{value:trueish}',
    'call:probe[]', 'call:probe(null)', 'call:probe{}extra', 'call:{}',
    'call:unsafe name{}', 'call:unsafe:name{}', 'call:名前{}', 'call:probe{名前:1}',
    `call:probe{value:${quote}ambiguous ${quote} tail${quote}}`,
  ])('rejects malformed or unsupported syntax without argument repair: %s', body => {
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: `${open}${body}${close}` });
    expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  it('accepts explicit null and finite JSON numbers without inventing empty-slot nulls', () => {
    const result = parse({ chunks: [`${open}call:probe{values:[null,0,-2,1.25,2e-3,4E+2,9007199254740991]}${close}`] });
    expect(JSON.parse(result.calls[0]!.function.arguments)).toEqual({ values: [null, 0, -2, 1.25, 0.002, 400, Number.MAX_SAFE_INTEGER] });
  });

  it('fails every incomplete suffix after recognizing a full call marker', () => {
    const source = `${open}call:probe{value:${quote}raw${quote}}${close}`;
    for (let index = open.length; index < source.length; index++) {
      const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
      parser.feed({ output: source.slice(0, index) });
      expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
      expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
    }
    expect(parse({ chunks: ['ordinary <|tool_cal'] })).toEqual({ text: 'ordinary <|tool_cal', calls: [] });
  });

  it('accepts the maximum depth and rejects the next container without truncation', () => {
    expect(parse({ chunks: [`${open}call:probe{value:${'['.repeat(63)}1${']'.repeat(63)}}${close}`] }).calls).toHaveLength(1);
    expect(() => parse({ chunks: [`${open}call:probe{value:${'['.repeat(64)}1${']'.repeat(64)}}${close}`] })).toThrow(Gemma4ToolCallProtocolError);
  });

  it('accepts sixteen calls but releases none when a seventeenth exceeds the generation cap', () => {
    const call = `${open}call:probe{}${close}`;
    expect(parse({ chunks: [call.repeat(16)] }).calls).toHaveLength(16);
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: call.repeat(17) });
    expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  it('bounds held protocol at 64 Ki UTF-16 code units across feed boundaries', () => {
    const prefix = `${open}call:probe{value:${quote}`;
    const suffix = `${quote}}${close}`;
    const source = prefix + 'x'.repeat(64 * 1024 - prefix.length - suffix.length) + suffix;
    expect(parse({ chunks: [source] }).calls).toHaveLength(1);
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => undefined });
    parser.feed({ output: source });
    expect(() => parser.feed({ output: 'x' })).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parse({ chunks: [source + 'x'] })).toThrow(Gemma4ToolCallProtocolError);
  });

  it('closes an already published thought when a buffered close precedes oversized protocol', () => {
    const chunks: string[] = [];
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: ({ text }) => chunks.push(text) });
    parser.feed({ output: `\
<|channel>thought
Partial` });
    expect(() => parser.feed({ output: `<channel|>${open}${'x'.repeat(65537)}` })).toThrow(Gemma4ToolCallProtocolError);
    expect(chunks.join('')).toBe('<think>Partial</think>');
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  it('removes unquoted terminal and padding controls from a bounded thought but preserves quoted data', () => {
    const chunks: string[] = [];
    const parser = new Gemma4ToolCallParser({ toolCalls: 'disabled', ignoredSpecialTokens: ['<pad>', '<bos>'], onText: ({ text }) => chunks.push(text) });
    parser.feed({ output: `\
<|channel>thought
Partial<|"|><eos><pad><|"|><eos><turn|><pad><bos>` });
    parser.flush();
    expect(chunks.join('')).toBe('<think>Partial<|"|><eos><pad><|"|></think>');
    expect(parser.drainToolCalls()).toEqual([]);
  });

  it('does not publish an orphan close for an uncommitted thought before malformed protocol', () => {
    const chunks: string[] = [];
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: ({ text }) => chunks.push(text) });
    parser.feed({ output: `${open}call:probe{}${close}<|channel>thought\nUnpublished<channel|>${open}broken` });
    expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
    expect(chunks).toEqual([]);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  it('streams long ordinary text without applying the held-protocol cap to the answer', () => {
    const chunks: string[] = [];
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: ({ text }) => chunks.push(text) });
    const text = 'ordinary '.repeat(10_000);
    parser.feed({ output: text });
    expect(chunks.join('')).toBe(text);
    parser.flush();
    expect(parser.drainToolCalls()).toEqual([]);
  });

  it('preserves callback failure and prevents tools from escaping a failed text delivery', () => {
    const failure = new Error('synthetic delivery failure');
    const parser = new Gemma4ToolCallParser({ toolCalls: 'enabled', ignoredSpecialTokens: [], onText: () => {
      throw failure;
    } });
    parser.feed({ output: `${open}call:probe{}${close}after` });
    expect(() => parser.flush()).toThrow(failure);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  describe('actual pinned native formatter controls, not sampled generation', () => {
    const NativeTemplate = bundledJinjaTemplate({ code: applyTransformersJsFixes({
      code: readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8'), version: '4.2.0',
    }).code });
    const template = new NativeTemplate(readFileSync('src/features/transformers-js/replay-models/onnx-community--gemma-4-e2b-it-onnx/model-chat_template.jinja', 'utf8'));

    function renderCall({ name, args }: { name: string, args: Record<string, unknown> }): string {
      const rendered = template.render({ bos_token: '<bos>', tools: [], add_generation_prompt: false,
        messages: [{ role: 'user', content: 'Synthetic protocol control.' }, { role: 'assistant', content: '',
          tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name, arguments: args } }] }],
      });
      const position = rendered.indexOf(open);
      expect(position).toBeGreaterThanOrEqual(0);
      return rendered.slice(position);
    }

    it.each(['9probe', 'probe.v1', 'probe-name', '$probe'])('round-trips the explicit ASCII subset for names and keys: %s', name => {
      const args = { [name]: 'raw\\n <tool_call|> text', nested: [true, 1.25, { key: 'value' }] };
      const result = parse({ chunks: [...renderCall({ name, args })] });
      expect(result.calls[0]!.function.name).toBe(name);
      expect(JSON.parse(result.calls[0]!.function.arguments)).toEqual(args);
    });

    it('does not pretend native empty null slots are explicit literal null', () => {
      const rendered = renderCall({ name: 'probe', args: { values: [1, null, 2] } });
      expect(rendered).toContain('[1,,2]');
      expect(() => parse({ chunks: [rendered] })).toThrow(Gemma4ToolCallProtocolError);
    });

    it.each(['a:b', 'white space', '名前'])('does not repair native names or bare keys outside the supported subset: %s', token => {
      expect(() => parse({ chunks: [renderCall({ name: token, args: {} })] })).toThrow(Gemma4ToolCallProtocolError);
      expect(() => parse({ chunks: [renderCall({ name: 'probe', args: { [token]: 1 } })] })).toThrow(Gemma4ToolCallProtocolError);
    });

    it('documents non-injective native quotes without claiming the parser can recover original provenance', () => {
      const oneString = renderCall({ name: 'probe', args: { a: `one${quote},b:${quote}two` } });
      const twoStrings = renderCall({ name: 'probe', args: { a: 'one', b: 'two' } });
      expect(oneString).toBe(twoStrings);
      // This is valid generated syntax. Known structured history with a quote
      // delimiter must be rejected before formatting, not guessed by parsing.
      expect(JSON.parse(parse({ chunks: [oneString] }).calls[0]!.function.arguments)).toEqual({ a: 'one', b: 'two' });
    });
  });
});
