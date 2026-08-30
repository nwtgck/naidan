import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import {
  detectStandardToolCallProtocol,
  formatStandardMessagesForToolCallProtocol,
} from './standard-tool-call-protocol';

function tokenizerWithRenderer({ renderer }: {
  renderer: (...args: unknown[]) => unknown,
}): Parameters<typeof detectStandardToolCallProtocol>[0]['tokenizer'] {
  return {
    apply_chat_template: renderer,
  } as unknown as Parameters<typeof detectStandardToolCallProtocol>[0]['tokenizer'];
}

describe('standard tool-call protocol', () => {
  it('detects the delimited Pythonic protocol from the LFM Investigation render shape', () => {
    const applyChatTemplate = vi.fn((_messages: unknown, _options: unknown) => `\
<|startoftext|><|im_start|>assistant
<|tool_call_start|>[__naidan_tool_protocol_probe__(value='__naidan_tool_protocol_probe_value__')]<|tool_call_end|><|im_end|>
<|im_start|>tool
__naidan_tool_protocol_probe_result__<|im_end|>
<|im_start|>assistant
<think>
`);
    const tokenizer = tokenizerWithRenderer({ renderer: applyChatTemplate });

    expect(detectStandardToolCallProtocol({ tokenizer, debugLog: vi.fn() }))
      .toBe('delimited-pythonic');

    const [messages, options] = applyChatTemplate.mock.calls[0]!;
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }),
      expect.objectContaining({ role: 'tool', content: '__naidan_tool_protocol_probe_result__' }),
    ]));
    expect(options).toMatchObject({
      add_generation_prompt: true,
      tokenize: false,
      return_dict: false,
      tools: expect.any(Array),
    });
  });

  it('caches protocol observation per tokenizer instance', () => {
    const applyChatTemplate = vi.fn(() => `\
<|tool_call_start|>[__naidan_tool_protocol_probe__(value='__naidan_tool_protocol_probe_value__')]<|tool_call_end|>
__naidan_tool_protocol_probe_result__`);
    const tokenizer = tokenizerWithRenderer({ renderer: applyChatTemplate });

    expect(detectStandardToolCallProtocol({ tokenizer, debugLog: vi.fn() })).toBe('delimited-pythonic');
    expect(detectStandardToolCallProtocol({ tokenizer, debugLog: vi.fn() })).toBe('delimited-pythonic');
    expect(applyChatTemplate).toHaveBeenCalledOnce();
  });


  it('does not enable the protocol when the template cannot preserve the tool-result continuation', () => {
    const tokenizer = tokenizerWithRenderer({
      renderer: vi.fn(() => `\
<|tool_call_start|>[__naidan_tool_protocol_probe__(value='__naidan_tool_protocol_probe_value__')]<|tool_call_end|>`),
    });

    expect(detectStandardToolCallProtocol({ tokenizer, debugLog: vi.fn() })).toBe('json-tagged');
  });

  it('does not classify a coincidental delimiter string as the protocol', () => {
    const tokenizer = tokenizerWithRenderer({
      renderer: vi.fn(() => `\
<|im_start|>assistant
The documentation says <|tool_call_start|>[other_tool(value='x')]<|tool_call_end|>.
`),
    });

    expect(detectStandardToolCallProtocol({ tokenizer, debugLog: vi.fn() })).toBe('json-tagged');
  });

  it('fails closed to the existing JSON-tagged protocol when observation throws', () => {
    const debugLog = vi.fn();
    const tokenizer = tokenizerWithRenderer({
      renderer: vi.fn(() => {
        throw new Error('template unavailable');
      }),
    });

    expect(detectStandardToolCallProtocol({ tokenizer, debugLog })).toBe('json-tagged');
    expect(debugLog).toHaveBeenCalledWith({
      event: 'standard tool-call protocol observation unavailable',
      details: { error: 'template unavailable' },
    });
  });

  it('converts stored JSON argument strings back to mappings only for Pythonic templates', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: generateId<ToolCallId>(),
          type: 'function',
          function: {
            name: 'shell_execute',
            arguments: JSON.stringify({ shell_script: 'ls -la /tmp', timeout_ms: 1000 }),
          },
        }],
      },
    ];

    const pythonic = formatStandardMessagesForToolCallProtocol({
      messages,
      protocol: 'delimited-pythonic',
    });
    const jsonTagged = formatStandardMessagesForToolCallProtocol({
      messages,
      protocol: 'json-tagged',
    });

    expect(pythonic[0]?.['tool_calls']).toEqual([expect.objectContaining({
      function: {
        name: 'shell_execute',
        arguments: { shell_script: 'ls -la /tmp', timeout_ms: 1000 },
      },
    })]);
    expect((jsonTagged[0]?.['tool_calls'] as ChatMessage['tool_calls'])?.[0]?.function.arguments)
      .toBe(JSON.stringify({ shell_script: 'ls -la /tmp', timeout_ms: 1000 }));
  });

  it('rejects non-object stored arguments for a template that requires mappings', () => {
    const messages: ChatMessage[] = [{
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: generateId<ToolCallId>(),
        type: 'function',
        function: { name: 'fn', arguments: '[]' },
      }],
    }];

    expect(() => formatStandardMessagesForToolCallProtocol({
      messages,
      protocol: 'delimited-pythonic',
    })).toThrow('must be a JSON object');
  });
});
