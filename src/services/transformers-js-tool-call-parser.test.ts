import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallStreamParser } from './transformers-js-tool-call-parser';

describe('ToolCallStreamParser', () => {
  let onText: ReturnType<typeof vi.fn<(text: string) => void>>;
  let parser: ToolCallStreamParser;

  beforeEach(() => {
    onText = vi.fn<(text: string) => void>();
    parser = new ToolCallStreamParser({ onText });
  });

  it('streams plain text immediately', () => {
    parser.feed({ output: 'hello world' });
    expect(onText).toHaveBeenCalledWith('hello world');
  });

  it('holds back a potential opening tag prefix and emits once it resolves', () => {
    parser.feed({ output: 'hello <tool_ca' });
    expect(onText).toHaveBeenCalledWith('hello ');
    onText.mockClear();

    // Resuming with non-tag characters: held-back prefix is flushed normally
    parser.feed({ output: 'll is not a tag' });
    expect(onText).toHaveBeenCalledWith('<tool_call is not a tag');
  });

  it('parses a tool call and returns it via drainToolCalls', () => {
    const payload = JSON.stringify({ name: 'my_func', arguments: { query: 'test' } });
    parser.feed({ output: `<tool_call>${payload}</tool_call>` });

    expect(onText).not.toHaveBeenCalled();

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('function');
    expect(calls[0]!.function.name).toBe('my_func');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ query: 'test' });
  });

  it('streams text before and after a tool call', () => {
    const payload = JSON.stringify({ name: 'fn', arguments: {} });
    parser.feed({ output: `prefix <tool_call>${payload}</tool_call> suffix` });

    expect(onText).toHaveBeenCalledWith('prefix ');
    expect(onText).toHaveBeenCalledWith(' suffix');

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('fn');
  });

  it('parses multiple tool calls in one feed', () => {
    const p1 = JSON.stringify({ name: 'fn1', arguments: { a: 1 } });
    const p2 = JSON.stringify({ name: 'fn2', arguments: { b: 2 } });
    parser.feed({ output: `<tool_call>${p1}</tool_call><tool_call>${p2}</tool_call>` });

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.function.name).toBe('fn1');
    expect(calls[1]!.function.name).toBe('fn2');
  });

  it('silently skips malformed tool call JSON', () => {
    parser.feed({ output: '<tool_call>not valid json</tool_call>' });

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(0);
    expect(onText).not.toHaveBeenCalled();
  });

  it('drainToolCalls clears the internal list', () => {
    const payload = JSON.stringify({ name: 'fn', arguments: {} });
    parser.feed({ output: `<tool_call>${payload}</tool_call>` });

    expect(parser.drainToolCalls()).toHaveLength(1);
    expect(parser.drainToolCalls()).toHaveLength(0);
  });

  it('flush emits remaining held-back text', () => {
    parser.feed({ output: 'text <tool_ca' }); // '<tool_ca' held back
    onText.mockClear();

    parser.flush();
    expect(onText).toHaveBeenCalledWith('<tool_ca');
  });

  it('flush discards an unclosed tool call block', () => {
    parser.feed({ output: '<tool_call>{"name":"fn","arguments":{}}' }); // no closing tag
    parser.flush();

    expect(onText).not.toHaveBeenCalled();
    expect(parser.drainToolCalls()).toHaveLength(0);
  });

  it('handles a tool call split across multiple feed calls', () => {
    const payload = JSON.stringify({ name: 'split_fn', arguments: { x: 'y' } });
    const full = `<tool_call>${payload}</tool_call>`;
    const mid = Math.floor(full.length / 2);

    parser.feed({ output: full.slice(0, mid) });
    parser.feed({ output: full.slice(mid) });

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.function.name).toBe('split_fn');
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ x: 'y' });
  });
});
