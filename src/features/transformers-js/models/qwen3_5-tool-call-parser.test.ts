import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Qwen3_5ToolCallParser } from './qwen3_5-tool-call-parser';
import type { WorkerToolJsonObject } from '@/features/transformers-js/types';

describe('Qwen3_5ToolCallParser', () => {
  let onText: ReturnType<typeof vi.fn<({ text }: { text: string }) => void>>;
  let parser: Qwen3_5ToolCallParser;

  beforeEach(() => {
    onText = vi.fn<({ text }: { text: string }) => void>();
    parser = new Qwen3_5ToolCallParser({ onText, tools: [{ type: 'function', function: {
      name: 'lookup', description: 'Synthetic typed XML control.', parameters: {
        type: 'object', properties: { options: { type: 'object' }, items: { type: 'array' }, ['__proto__']: { type: 'object' } },
      },
    } }] });
  });

  it('parses a Qwen3.5 tool call with typed parameters', () => {
    parser.feed({
      output: `\
<tool_call>
<function=shell_execute>
<parameter=shell_script>
ls -la /tmp
</parameter>
<parameter=stdout_limit>
20
</parameter>
<parameter=stderr_limit>
0
</parameter>
<parameter=use_shell>
true
</parameter>
</function>
</tool_call>`,
    });

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function.name).toBe('shell_execute');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      shell_script: 'ls -la /tmp',
      stdout_limit: 20,
      stderr_limit: 0,
      use_shell: true,
    });
  });

  it.each<{ name: string; schema: WorkerToolJsonObject; raw: string; expected: unknown }>([
    { name: 'explicit number', schema: { type: 'number' }, raw: '12', expected: 12 },
    { name: 'explicit numeric string', schema: { type: 'string' }, raw: '12', expected: '12' },
    { name: 'nullable object', schema: { type: ['object', 'null'] }, raw: '{"a":1}', expected: { a: 1 } },
    { name: 'nullable object null', schema: { anyOf: [{ type: 'object' }, { type: 'null' }] }, raw: 'null', expected: null },
    { name: 'malformed object remains invalid for Provider validation', schema: { type: 'object' }, raw: '{broken}', expected: '{broken}' },
    { name: 'unresolved reference does not guess structure', schema: { $ref: '#/$defs/value' }, raw: '{"a":1}', expected: '{"a":1}' },
    { name: 'unconstrained schema does not guess structure', schema: {}, raw: '[1,2]', expected: '[1,2]' },
    { name: 'overflow cannot become an accepted nullable number', schema: { type: ['number', 'null'] }, raw: '1e999', expected: '1e999' },
    { name: 'nested overflow cannot become null inside a container', schema: { type: 'object' }, raw: '{"value":1e999}', expected: '{"value":1e999}' },
    { name: 'mixed compositions do not choose a winning branch', schema: { anyOf: [{ type: 'object' }], oneOf: [{ type: 'string' }] }, raw: '{"a":1}', expected: '{"a":1}' },
  ])('$name', ({ schema, raw, expected }) => {
    const typed = new Qwen3_5ToolCallParser({ onText, tools: [{ type: 'function', function: {
      name: 'probe', description: 'Synthetic XML type control.', parameters: { type: 'object', properties: { value: schema } },
    } }] });
    typed.feed({ output: `<tool_call><function=probe><parameter=value>${raw}</parameter></function></tool_call>` });
    typed.flush();
    const calls = typed.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ value: expected });
  });

  it('does not borrow a registered tool schema for an unknown tool name', () => {
    parser.feed({ output: '<tool_call><function=unknown><parameter=options>{"city":"Tokyo"}</parameter></function></tool_call>' });
    parser.flush();
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('unknown');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ options: '{"city":"Tokyo"}' });
  });

  it.each([
    '<tool_call>{"name":"lookup","arguments":{"value":1e999}}</tool_call>',
    '<tool_call>{name: lookup, arguments: {value: [1e999]}}</tool_call>',
  ])('rejects non-finite JSON arguments before serialization can substitute null: %s', output => {
    expect(() => parser.feed({ output })).toThrow('Non-finite Qwen tool argument');
    expect(parser.drainToolCalls()).toEqual([]);
  });

  it('handles a Qwen3.5 tool call split across tokens', () => {
    parser.feed({ output: `\
<tool_call>
<function=shell_execute>
<parameter=shell_script>
` });
    parser.feed({ output: `\
pwd
</parameter>
</function>
</tool_call>` });

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ shell_script: 'pwd' });
  });

  it('preserves a JSON object parameter emitted by the native XML template grammar', () => {
    // The pinned native template uses tojson for mapping values. This is a
    // synthetic protocol control, not evidence that a model generated a tool.
    parser.feed({ output: `\
<tool_call>
<function=lookup>
<parameter=options>
{"city": "Tokyo", "count": 2, "enabled": false}
</parameter>
</function>
</tool_call>` });
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ options: { city: 'Tokyo', count: 2, enabled: false } });
    expect(onText).not.toHaveBeenCalled();
  });

  it('preserves a JSON array parameter emitted by the native XML template grammar', () => {
    parser.feed({ output: `\
<tool_call>
<function=lookup>
<parameter=items>
["12", 12, {"nested": [true, null]}]
</parameter>
</function>
</tool_call>` });
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ items: ['12', 12, { nested: [true, null] }] });
    expect(onText).not.toHaveBeenCalled();
  });

  it('parses relaxed JSON-like tool calls with bare identifiers', () => {
    parser.feed({
      output: `\
<tool_call>
{"name": shell_execute, "arguments": {"shell_script": "ls -la /tmp/sample-dir | head -5", "stdout_limit": 1024, "stderr_limit": 1024, "timeout_ms": 5000}}
</tool_call>`,
    });

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.function.name).toBe('shell_execute');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      shell_script: 'ls -la /tmp/sample-dir | head -5',
      stdout_limit: 1024,
      stderr_limit: 1024,
      timeout_ms: 5000,
    });
  });

  it('preserves a structured XML parameter named __proto__ as an own JSON key', () => {
    parser.feed({ output: '<tool_call><function=lookup><parameter=__proto__>{"city":"Tokyo"}</parameter></function></tool_call>' });
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.arguments).toBe('{"__proto__":{"city":"Tokyo"}}');
    const decoded: unknown = JSON.parse(calls[0]!.function.arguments);
    expect(Object.hasOwn(decoded as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('preserves __proto__ inside relaxed JSON arguments without changing the dictionary prototype', () => {
    parser.feed({ output: '<tool_call>{"name": lookup, "arguments": {"__proto__": {"city": Tokyo}}}</tool_call>' });
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.arguments).toBe('{"__proto__":{"city":"Tokyo"}}');
    expect(Object.getPrototypeOf(JSON.parse(calls[0]!.function.arguments))).toBe(Object.prototype);
  });

  it('streams plain text outside tool calls', () => {
    parser.feed({ output: 'before ' });
    parser.feed({
      output: `\
<tool_call>
<function=test>
<parameter=arg>
hello
</parameter>
</function>
</tool_call>`,
    });
    parser.feed({ output: ' after' });

    expect(onText).toHaveBeenCalledWith({ text: 'before ' });
    expect(onText).toHaveBeenCalledWith({ text: ' after' });
  });

  it('preserves malformed tool call blocks as plain text', () => {
    parser.feed({
      output: `\
<tool_call>
<function=shell_execute>
<parameter=shell_script>
pwd
</parameter>
</tool_call>`,
    });

    expect(parser.drainToolCalls()).toHaveLength(0);
    expect(onText).toHaveBeenCalledWith({ text: `\
<tool_call>
<function=shell_execute>
<parameter=shell_script>
pwd
</parameter>
</tool_call>` });
  });
});
