import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIMITED_PYTHONIC_TOOL_CALL_CLOSE,
  DELIMITED_PYTHONIC_TOOL_CALL_OPEN,
  DelimitedPythonicToolCallStreamParser,
  TEST_ONLY,
  type DelimitedPythonicToolCallStreamEvent,
} from './delimited-pythonic-tool-call-parser';

describe('DelimitedPythonicToolCallStreamParser', () => {
  let onText: ReturnType<typeof vi.fn<({ text }: { text: string }) => void>>;

  beforeEach(() => {
    onText = vi.fn<({ text }: { text: string }) => void>();
  });

  function createParser({ toolNames, onEvent }: {
    toolNames: string[],
    onEvent?: ({ event }: { event: DelimitedPythonicToolCallStreamEvent }) => void,
  }): DelimitedPythonicToolCallStreamParser {
    return new DelimitedPythonicToolCallStreamParser({
      onText,
      onEvent,
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

  it('suppresses an unterminated string block instead of executing or persisting protocol text', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const output = "<|tool_call_start|>[shell_execute(shell_script='unterminated)]<|tool_call_end|>";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).not.toHaveBeenCalled();
  });

  it('suppresses an unclosed tool-call block on flush instead of leaking protocol text', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const output = "<|tool_call_start|>[shell_execute(shell_script='ls')";

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText).not.toHaveBeenCalled();
  });

  it('preserves ordinary text before an incomplete tool-call block while suppressing only the protocol suffix', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    parser.feed({ output: "The game is ready.<|tool_call_start|>[shell_execute(shell_script='cd /" });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe('The game is ready.');
  });

  it('builds an explicit AST before converting arguments to ToolCall JSON', () => {
    const ast = TEST_ONLY.parseDelimitedPythonicToolCallPayloadAst({
      content: `[complex_tool(text='hello', options={"nested":[1, true, null]})]`,
    });

    expect(ast).toEqual({
      type: 'tool-call-list',
      calls: [{
        type: 'function-call',
        name: 'complex_tool',
        arguments: [
          { name: 'text', value: { type: 'string', value: 'hello' } },
          {
            name: 'options',
            value: {
              type: 'object',
              entries: [{
                key: 'nested',
                value: {
                  type: 'array',
                  items: [
                    { type: 'number', value: 1 },
                    { type: 'boolean', value: true },
                    { type: 'null' },
                  ],
                },
              }],
            },
          },
        ],
      }],
    });
  });

  it('emits provisional call ASTs incrementally but commits only after the whole list and close delimiter', () => {
    const events: DelimitedPythonicToolCallStreamEvent[] = [];
    const parser = createParser({
      toolNames: ['first_tool', 'second_tool'],
      onEvent: ({ event }) => events.push(event),
    });

    parser.feed({ output: `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[first_tool(value='one'), second_tool(value='` });

    expect(events).toEqual([
      expect.objectContaining({ type: 'call-parsed', blockId: 0, callIndex: 0 }),
    ]);
    expect(parser.drainToolCalls()).toEqual([]);

    parser.feed({ output: `two')]` });
    expect(events).toEqual([
      expect.objectContaining({ type: 'call-parsed', blockId: 0, callIndex: 0 }),
      expect.objectContaining({ type: 'call-parsed', blockId: 0, callIndex: 1 }),
    ]);
    expect(parser.drainToolCalls()).toEqual([]);

    for (const character of DELIMITED_PYTHONIC_TOOL_CALL_CLOSE) parser.feed({ output: character });

    expect(events.at(-1)).toEqual({ type: 'block-committed', blockId: 0, callCount: 2 });
    expect(parser.drainToolCalls().map(call => call.function.name)).toEqual(['first_tool', 'second_tool']);
  });

  it('rejects the whole block when a later call is malformed after an earlier call AST completed', () => {
    const events: DelimitedPythonicToolCallStreamEvent[] = [];
    const parser = createParser({
      toolNames: ['first_tool', 'second_tool'],
      onEvent: ({ event }) => events.push(event),
    });
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[first_tool(value='safe'), second_tool(value=)]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    parser.feed({ output });
    parser.flush();

    expect(events).toEqual([
      expect.objectContaining({ type: 'call-parsed', blockId: 0, callIndex: 0 }),
      { type: 'block-rejected', blockId: 0, reason: 'invalid-syntax' },
    ]);
    expect(parser.drainToolCalls()).toEqual([]);
    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe(output);
  });

  it('treats shell heredoc syntax and escaped JavaScript quotes as string data, not tool-call syntax', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[shell_execute(shell_script='cat > /workspace/game.html << \\'EOF\\'\\n<script>\\nconst mole = document.getElementById(\\'mole\\');\\n</script>\\nEOF')]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    for (const character of output) parser.feed({ output: character });
    parser.flush();

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      shell_script: `\
cat > /workspace/game.html << 'EOF'
<script>
const mole = document.getElementById('mole');
</script>
EOF`,
    });
    expect(onText).not.toHaveBeenCalled();
  });

  it('does not treat a close-delimiter-shaped string inside an argument as the frame delimiter', () => {
    const parser = createParser({ toolNames: ['write_file'] });
    const delimiterText = DELIMITED_PYTHONIC_TOOL_CALL_CLOSE;
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[write_file(content='before ${delimiterText} after')]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    for (const character of output) parser.feed({ output: character });
    parser.flush();

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ content: `before ${delimiterText} after` });
    expect(onText).not.toHaveBeenCalled();
  });

  it('fails closed when a long heredoc-like argument is truncated before its string, call, list, and frame close', () => {
    const events: DelimitedPythonicToolCallStreamEvent[] = [];
    const parser = createParser({
      toolNames: ['shell_execute'],
      onEvent: ({ event }) => events.push(event),
    });
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[shell_execute(shell_script='cat > /workspace/games/mole_punch.html << \\'EOF\\'\\n<!DOCTYPE html>\\n<style>\\nbody { font-family: \\'Segoe UI\\', sans-serif; }\\n</style>\\n<script>\\nconst mole = document.getElementById(\\'mole\\');\\n`;

    for (let offset = 0; offset < output.length; offset += 7) {
      parser.feed({ output: output.slice(offset, offset + 7) });
    }
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'block-rejected', blockId: 0, reason: 'incomplete' });
    expect(onText).not.toHaveBeenCalled();
  });

  it('never commits any proper prefix of a valid delimited tool-call block', () => {
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[shell_execute(shell_script='printf \\'ok\\'\\n')]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    for (let length = 1; length < output.length; length++) {
      const parser = new DelimitedPythonicToolCallStreamParser({
        onText: () => {},
        allowedToolNames: new Set(['shell_execute']),
      });
      parser.feed({ output: output.slice(0, length) });
      parser.flush();
      expect(parser.drainToolCalls(), `prefix length ${length}`).toEqual([]);
    }
  });

  it('rejects a complete AST if the closing protocol delimiter is missing or replaced', () => {
    const events: DelimitedPythonicToolCallStreamEvent[] = [];
    const parser = createParser({
      toolNames: ['shell_execute'],
      onEvent: ({ event }) => events.push(event),
    });
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[shell_execute(shell_script='ls')]not-the-close${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'block-rejected', blockId: 0, reason: 'missing-close-delimiter' });
    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe(output);
  });

  it('rejects an empty Pythonic call list rather than treating it as a successful tool turn', () => {
    const events: DelimitedPythonicToolCallStreamEvent[] = [];
    const parser = createParser({
      toolNames: ['shell_execute'],
      onEvent: ({ event }) => events.push(event),
    });
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    parser.feed({ output });
    parser.flush();

    expect(parser.drainToolCalls()).toEqual([]);
    expect(events).toEqual([{ type: 'block-rejected', blockId: 0, reason: 'empty-tool-call-list' }]);
    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe(output);
  });

  it('recovers after an invalid block and parses a later valid block from the same stream', () => {
    const parser = createParser({ toolNames: ['shell_execute'] });
    const invalid = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[shell_execute(shell_script=)]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;
    const valid = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[shell_execute(shell_script='pwd')]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    parser.feed({ output: `before ${invalid} between ${valid} after` });
    parser.flush();

    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe(`before ${invalid} between  after`);
    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({ shell_script: 'pwd' });
  });

  it('rejects duplicate object keys and excessive nesting without executing a partial call', () => {
    const duplicate = createParser({ toolNames: ['safe_tool'] });
    const duplicateOutput = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[safe_tool(value={"a":1,"a":2})]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;
    duplicate.feed({ output: duplicateOutput });
    duplicate.flush();
    expect(duplicate.drainToolCalls()).toEqual([]);

    onText.mockClear();
    const nested = createParser({ toolNames: ['safe_tool'] });
    const nesting = '['.repeat(66) + 'null' + ']'.repeat(66);
    const nestedOutput = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[safe_tool(value=${nesting})]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;
    nested.feed({ output: nestedOutput });
    nested.flush();
    expect(nested.drainToolCalls()).toEqual([]);
    expect(onText.mock.calls.map(([value]) => value.text).join('')).toBe(nestedOutput);
  });

  it('round-trips escaped Unicode and delimiter punctuation inside nested values', () => {
    const parser = createParser({ toolNames: ['complex_tool'] });
    const output = `${DELIMITED_PYTHONIC_TOOL_CALL_OPEN}[complex_tool(value={"text":"\\u65e5\\u672c)]},= ${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}","items":["a,b",true,None,-1.25e2]})]${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`;

    parser.feed({ output });
    parser.flush();

    const calls = parser.drainToolCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.function.arguments)).toEqual({
      value: {
        text: `日本)]},= ${DELIMITED_PYTHONIC_TOOL_CALL_CLOSE}`,
        items: ['a,b', true, null, -125],
      },
    });
  });

});
