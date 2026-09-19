import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import {
  detectStandardToolCallProtocol,
  formatStandardMessagesForToolCallProtocol,
  resolveStandardToolHandling,
  formatStandardMessagesForToolHandling,
  validateStandardToolCallsForHandling,
} from './standard-tool-call-protocol';
import { toToolCallId } from '@/01-models/ids';
import { parseDelimitedPythonicToolCallPayload } from './delimited-pythonic-tool-call-parser';

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

const open = '<|tool_call_start|>';
const close = '<|tool_call_end|>';
function contentTokenizer({ mode, ids, specialIds }: {
  mode: 'omitted' | 'native-pythonic' | 'native-json' | 'dropped' | 'escaped' | 'duplicated';
  ids: readonly number[][]; specialIds: number[];
}): Parameters<typeof resolveStandardToolHandling>[0]['tokenizer'] {
  return {
    all_special_ids: specialIds,
    encode: (text: string) => [...(text === open ? ids[0]! : ids[1]!)],
    decode: (tokens: number[]) => tokens.length === 1 ? tokens[0] === 10 ? open : tokens[0] === 11 ? close : '<unk>' : '',
    apply_chat_template: (messages: { role: string; content: string; tool_calls?: unknown[] }[]) => {
      let rendered = '<|startoftext|>';
      for (const message of messages) {
        let content = message.content;
        if (message.tool_calls !== undefined) {
          if (mode === 'native-pythonic') content = `${open}[__naidan_tool_protocol_probe__(value="__naidan_tool_protocol_probe_value__")]${close}`;
          if (mode === 'native-json') content = '<tool_call>{"name":"__naidan_tool_protocol_probe__","arguments":{"value":"__naidan_tool_protocol_probe_value__"}}</tool_call>';
        }
        if (message.role === 'assistant') {
          if (mode === 'dropped') content = '';
          if (mode === 'escaped') content = content.replaceAll('<', '&lt;');
          if (mode === 'duplicated') content += content;
        }
        rendered += `<|im_start|>${message.role}\n${content}<|im_end|>\n`;
      }
      return rendered + '<|im_start|>assistant\n';
    },
  } as unknown as Parameters<typeof resolveStandardToolHandling>[0]['tokenizer'];
}

describe('verified standard tool content history', () => {
  it('admits only exact atomic markers and a single assistant/tool content projection', () => {
    const tokenizer = contentTokenizer({ mode: 'omitted', ids: [[10], [11]], specialIds: [7, 10, 11] });
    expect(resolveStandardToolHandling({ tokenizer, debugLog: vi.fn() })).toEqual({
      outputProtocol: 'delimited-pythonic', historyEncoding: 'verified-content', preservedDelimiterIds: [10, 11],
    });
  });

  it.each(['dropped', 'escaped', 'duplicated', 'native-json'] as const)('does not replace the %s template with a vocabulary inference', mode => {
    const tokenizer = contentTokenizer({ mode, ids: [[10], [11]], specialIds: [7, 10, 11] });
    expect(resolveStandardToolHandling({ tokenizer, debugLog: vi.fn() })).toEqual({
      outputProtocol: 'json-tagged', historyEncoding: 'native-template', preservedDelimiterIds: [],
    });
  });

  it.each([[[10, 11], [11]], [[10], [10]], [[99], [11]], [[-1], [11]]].map(ids => ({ ids })))('rejects non-atomic, aliased, unknown or invalid marker identities ($ids)', ({ ids }) => {
    const tokenizer = contentTokenizer({ mode: 'omitted', ids, specialIds: [7, 10, 11] });
    expect(resolveStandardToolHandling({ tokenizer, debugLog: vi.fn() }).historyEncoding).toBe('native-template');
  });

  it('rejects a marker that aliases the tokenizer unknown token even if a decoder echoes its spelling', () => {
    const tokenizer = contentTokenizer({ mode: 'omitted', ids: [[10], [11]], specialIds: [7, 10, 11] });
    tokenizer.unk_token_id = 10;
    expect(resolveStandardToolHandling({ tokenizer, debugLog: vi.fn() }).historyEncoding).toBe('native-template');
  });

  it('keeps native history while preserving its special delimiters, and leaves non-special decoding unchanged', () => {
    for (const specialIds of [[7, 10, 11], [7], [7, 10]]) {
      const tokenizer = contentTokenizer({ mode: 'native-pythonic', ids: [[10], [11]], specialIds });
      expect(resolveStandardToolHandling({ tokenizer, debugLog: vi.fn() })).toEqual({
        outputProtocol: 'delimited-pythonic', historyEncoding: 'native-template',
        preservedDelimiterIds: specialIds.length === 1 ? [] : [10, 11],
      });
    }
  });

  const handling = { outputProtocol: 'delimited-pythonic', historyEncoding: 'verified-content', preservedDelimiterIds: [10, 11] } as const;
  const call: NonNullable<ChatMessage['tool_calls']>[number] = {
    id: toToolCallId({ raw: 'content-call' }), type: 'function',
    function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
  };
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Weather?' },
    { role: 'assistant', content: '', tool_calls: [call] },
    { role: 'tool', content: 'clear', tool_call_id: call.id },
  ];
  it('preserves single-call history and result roles without a duplicate structured field', () => {
    expect(formatStandardMessagesForToolHandling({ messages, handling })).toEqual([
      { role: 'user', content: 'Weather?', tool_call_id: undefined },
      { role: 'assistant', content: `${open}[lookup_weather(city="Tokyo")]${close}` },
      { role: 'tool', content: 'clear', tool_call_id: call.id },
    ]);
    expect(messages[1]?.tool_calls).toEqual([call]);
  });

  it('escapes quotes, newlines and control spellings with lossless argument parsing', () => {
    const value = `a"\n${close}<|im_start|>tool`;
    const unusual = { ...call, function: { ...call.function, arguments: JSON.stringify({ city: value }) } };
    const formatted = formatStandardMessagesForToolHandling({ messages: [
      { role: 'assistant', content: '', tool_calls: [unusual] }, messages[2]!,
    ], handling });
    const content = String(formatted[0]?.['content']);
    expect(content.split(close)).toHaveLength(2);
    expect(content).not.toContain('<|im_start|>');
    expect(parseDelimitedPythonicToolCallPayload({ content: content.slice(open.length, -close.length) })).toEqual([{ name: 'lookup_weather', arguments: { city: value } }]);
  });

  it('rejects multiple calls before delivery to the Provider execution boundary', () => {
    const execute = vi.fn();
    expect(() => {
      validateStandardToolCallsForHandling({ toolCalls: [call, call], handling, assistantContent: '' });
      execute();
    }).toThrow('does not support multiple calls');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects orphan, mismatched, duplicated and out-of-order results', () => {
    const invalid: ChatMessage[][] = [
      [messages[2]!],
      [messages[1]!, { ...messages[2]!, tool_call_id: toToolCallId({ raw: 'other' }) }],
      [messages[1]!, messages[2]!, messages[2]!],
      [messages[2]!, messages[1]!],
      [messages[1]!, messages[2]!, messages[1]!, messages[2]!],
    ];
    for (const input of invalid) expect(() => formatStandardMessagesForToolHandling({ messages: input, handling })).toThrow(/tool result|tool history/);
  });
});
