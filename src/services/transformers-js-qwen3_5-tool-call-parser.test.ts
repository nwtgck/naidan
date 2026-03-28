import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Qwen3_5ToolCallParser } from './transformers-js-qwen3_5-tool-call-parser';

describe('Qwen3_5ToolCallParser', () => {
  let onText: ReturnType<typeof vi.fn<(text: string) => void>>;
  let parser: Qwen3_5ToolCallParser;

  beforeEach(() => {
    onText = vi.fn<(text: string) => void>();
    parser = new Qwen3_5ToolCallParser({ onText });
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

    expect(onText).toHaveBeenCalledWith('before ');
    expect(onText).toHaveBeenCalledWith(' after');
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
    expect(onText).toHaveBeenCalledWith(`\
<tool_call>
<function=shell_execute>
<parameter=shell_script>
pwd
</parameter>
</tool_call>`);
  });
});
