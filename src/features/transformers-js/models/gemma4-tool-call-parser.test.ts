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
  const parser = new Gemma4ToolCallParser({ onText: ({ text: chunk }) => text.push(chunk) });
  for (const output of chunks) parser.feed({ output });
  parser.flush();
  return { text: text.join(''), calls: parser.drainToolCalls() };
}

describe('Gemma native tool-call protocol controls, not model output evidence', () => {
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

  it('reports an incomplete recognized call instead of converting it into a successful answer', () => {
    const parser = new Gemma4ToolCallParser({ onText: () => undefined });
    parser.feed({ output: `${open}call:probe{key:${quote}unfinished` });
    expect(() => parser.flush()).toThrow();
  });

  it('does not release an earlier valid call when a later call is invalid', () => {
    const parser = new Gemma4ToolCallParser({ onText: () => undefined });
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
      expect(result.text).toBe(`\
thought
call:do_not_execute{value:1}Visible  answer`);
      expect(result.calls.map(call => call.function.name)).toEqual(['allowed']);
    }
  });

  it('holds all calls until flush, assigns distinct IDs to repeated names, and drains only once', () => {
    const parser = new Gemma4ToolCallParser({ onText: () => undefined });
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
    const parser = new Gemma4ToolCallParser({ onText: () => undefined });
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
      const parser = new Gemma4ToolCallParser({ onText: () => undefined });
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
    const parser = new Gemma4ToolCallParser({ onText: () => undefined });
    parser.feed({ output: call.repeat(17) });
    expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
  });

  it('bounds held protocol at 64 Ki UTF-16 code units across feed boundaries', () => {
    const prefix = `${open}call:probe{value:${quote}`;
    const suffix = `${quote}}${close}`;
    const source = prefix + 'x'.repeat(64 * 1024 - prefix.length - suffix.length) + suffix;
    expect(parse({ chunks: [source] }).calls).toHaveLength(1);
    const parser = new Gemma4ToolCallParser({ onText: () => undefined });
    parser.feed({ output: source });
    expect(() => parser.feed({ output: 'x' })).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.flush()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parser.drainToolCalls()).toThrow(Gemma4ToolCallProtocolError);
    expect(() => parse({ chunks: [source + 'x'] })).toThrow(Gemma4ToolCallProtocolError);
  });

  it('streams long ordinary text without applying the held-protocol cap to the answer', () => {
    const chunks: string[] = [];
    const parser = new Gemma4ToolCallParser({ onText: ({ text }) => chunks.push(text) });
    const text = 'ordinary '.repeat(10_000);
    parser.feed({ output: text });
    expect(chunks.join('')).toBe(text);
    parser.flush();
    expect(parser.drainToolCalls()).toEqual([]);
  });

  it('preserves callback failure and prevents tools from escaping a failed text delivery', () => {
    const failure = new Error('synthetic delivery failure');
    const parser = new Gemma4ToolCallParser({ onText: () => {
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
    const template = new NativeTemplate(readFileSync('src/features/transformers-js/download-verification/fixtures/model-runtime-data/gemma4-e2b/chat_template.jinja', 'utf8'));

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
