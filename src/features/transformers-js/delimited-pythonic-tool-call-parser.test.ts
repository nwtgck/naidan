import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelimitedPythonicToolCallStreamParser } from './delimited-pythonic-tool-call-parser';

describe('DelimitedPythonicToolCallStreamParser', () => {
  let onText: ReturnType<typeof vi.fn<({ text }: { text: string }) => void>>;

  beforeEach(() => {
    onText = vi.fn<({ text }: { text: string }) => void>();
  });

  function createParser({ toolNames }: { toolNames: string[] }): DelimitedPythonicToolCallStreamParser {
    return new DelimitedPythonicToolCallStreamParser({
      onText,
      allowedToolNames: new Set(toolNames),
    });
  }

  it('parses the observed LFM multi-tool output across its real browser chunk boundaries', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const chunks = [
      "directory.</think><|tool_call_start|>[shell_execute(shell_script='ls ",
      '-la ',
      "/workspace'), ",
      "shell_execute(shell_script='ls ",
      '-la ',
      "/tmp')]<|tool_call_end|>",
    ];

    for (const chunk of chunks) parser.feed({ output: chunk });
    parser.flush();

    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe('directory.</think>');
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(2);
    expect(calls.map(call => ({
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments) as unknown,
    }))).toEqual([
      { name: 'shell_execute', arguments: { shell_script: 'ls -la /workspace' } },
      { name: 'shell_execute', arguments: { shell_script: 'ls -la /tmp' } },
    ]);
  });

  it('handles delimiters and payload syntax split at arbitrary boundaries', () => {
    const parser = createParser({ toolNames: ['lookup_weather'] });
    const output = "<|tool_call_start|>[lookup_weather(city='Tokyo')]<|tool_call_end|>";

    for (const character of output) parser.feed({ output: character });
    parser.flush();

    expect(onText).not.toHaveBeenCalled();
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('lookup_weather');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ city: 'Tokyo' });
  });

  it('parses template-compatible strings, JSON containers, numbers, booleans, and null', () => {
    const parser = createParser({ toolNames: ['complex_tool'] });
    parser.feed({
      output: `<|tool_call_start|>[complex_tool(text='line\\nquote\\'slash\\\\', object={"nested":[1,true,null,"x"]}, count=-2.5, enabled=True, missing=None)]<|tool_call_end|>`,
    });
    parser.flush();

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      text: "line\nquote'slash\\",
      object: { nested: [1, true, null, 'x'] },
      count: -2.5,
      enabled: true,
      missing: null,
    });
  });

  it('treats prototype-like argument keys as data without mutating object prototypes', () => {
    const parser = createParser({ toolNames: ['safe_tool'] });
    parser.feed({
      output: `<|tool_call_start|>[safe_tool(__proto__={"polluted":true}, constructor={"prototype":{"alsoPolluted":true}})]<|tool_call_end|>`,
    });
    parser.flush();

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    const parsedArguments = JSON.parse(calls[0]!.function.arguments) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsedArguments, '__proto__')).toBe(true);
    expect(parsedArguments['__proto__']).toEqual({ polluted: true });
    expect(parsedArguments['constructor']).toEqual({ prototype: { alsoPolluted: true } });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['alsoPolluted']).toBeUndefined();
  });


  it('fails closed on duplicate argument names instead of choosing one value', () => {
    const parser = createParser({ toolNames: ['lookup_weather'] });
    const output = "<|tool_call_start|>[lookup_weather(city='Tokyo', city='Osaka')]<|tool_call_end|>";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).toHaveBeenCalledWith({ text: output });
  });
  it('preserves a syntactically valid call to a tool that was not offered', () => {
    const parser = createParser({ toolNames: ['allowed_tool'] });
    const output = "<|tool_call_start|>[other_tool(value='x')]<|tool_call_end|>";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).toHaveBeenCalledWith({ text: output });
  });


  it('does not partially execute a multi-call block when any tool was not offered', () => {
    const parser = createParser({ toolNames: ['allowed_tool'] });
    const output = "<|tool_call_start|>[allowed_tool(value='safe'), other_tool(value='x')]<|tool_call_end|>";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).toHaveBeenCalledWith({ text: output });
  });

  it('preserves malformed protocol output instead of executing or dropping it', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const output = "<|tool_call_start|>[shell_execute(shell_script='unterminated)]<|tool_call_end|>";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).toHaveBeenCalledWith({ text: output });
  });

  it('preserves an unclosed tool-call block on flush', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const output = "<|tool_call_start|>[shell_execute(shell_script='ls')";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).toHaveBeenCalledWith({ text: output });
  });
});
