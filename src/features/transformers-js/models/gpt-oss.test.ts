import { beforeEach, describe, expect, it, vi } from 'vitest';

const streaming = vi.hoisted((): { callback: ((text: string) => void) | undefined } => ({ callback: undefined }));

vi.mock('@huggingface/transformers', () => ({
  Tensor: class {},
  TextStreamer: class {
    // Mirror the external TextStreamer constructor used by the runtime.
    constructor(_tokenizer: unknown, options: { callback_function: (text: string) => void }) {
      streaming.callback = options.callback_function;
    }
  },
}));

import { toToolCallId } from '@/01-models/ids';
import { generateGptOss, TEST_ONLY } from './gpt-oss';
import type { InferenceMessage } from '@/features/transformers-js/types';

function continuationMessages() {
  const toolCallId = toToolCallId({ raw: 'call_1' });
  return [
    { role: 'user' as const, content: 'run it' },
    {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{
        id: toolCallId,
        type: 'function' as const,
        function: { name: 'my_tool', arguments: '{}' },
      }],
    },
    { role: 'tool' as const, content: 'done', tool_call_id: toolCallId },
  ];
}

function tokenizerFixture() {
  const applyChatTemplate = vi.fn().mockReturnValue({ input_ids: { data: BigInt64Array.from([10n, 11n, 12n]) } });
  const callable = Object.assign(
    vi.fn().mockReturnValue({ input_ids: { data: BigInt64Array.from([90n, 91n]) } }),
    { apply_chat_template: applyChatTemplate },
  );
  return { tokenizer: callable, applyChatTemplate, callable };
}

function generateWithModelFixture() {
  return vi.fn().mockResolvedValue({ past_key_values: { layer_0: {} } });
}

const stoppingCriteria = { reset: vi.fn(), interrupt: vi.fn() };
const tools = [{
  type: 'function' as const,
  function: {
    name: 'my_tool',
    description: 'fixture tool',
    parameters: { type: 'object' },
  },
}];

describe('generateGptOss input observation', () => {
  it.each(['absent', 'undefined'] as const)('omits %s tool fields before rendering ordinary assistant history', async shape => {
    const { tokenizer, applyChatTemplate } = tokenizerFixture();
    const ordinary = { role: 'assistant', content: 'Synthetic answer.' };
    const messages = [
      { role: 'user', content: 'Synthetic user.' },
      shape === 'undefined' ? { ...ordinary, tool_calls: undefined, tool_call_id: undefined } : ordinary,
      { role: 'user', content: 'Continue.' },
    ];
    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never, tokenizer: tokenizer as never, messages,
      onChunk: vi.fn(), onToolCalls: vi.fn(), params: undefined, tools,
      pastKeyValues: undefined, stoppingCriteria, onInputPrepared: undefined,
      generateWithModel: generateWithModelFixture(),
    });
    expect(applyChatTemplate.mock.calls[0]?.[0]).toStrictEqual([
      { role: 'developer', content: expect.stringContaining('namespace functions') },
      { role: 'user', content: 'Synthetic user.' },
      ordinary,
      { role: 'user', content: 'Continue.' },
    ]);
  });

  it('reports full input and refuses an unowned cache despite tool-shaped supplied history', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();
    const onInputPrepared = vi.fn();
    const pastKeyValues = { cached: true };

    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never,
      tokenizer: tokenizer as never,
      messages: continuationMessages(),
      onChunk: vi.fn(),
      onToolCalls: vi.fn(),
      params: undefined,
      tools,
      pastKeyValues,
      stoppingCriteria,
      onInputPrepared,
      generateWithModel,
    });

    expect(callable).not.toHaveBeenCalled();
    expect(applyChatTemplate).toHaveBeenCalledOnce();
    expect(onInputPrepared).toHaveBeenCalledWith({
      fullConversationInputs: { input_ids: { data: BigInt64Array.from([10n, 11n, 12n]) } },
      cacheDecision: { status: 'not-reused', reason: 'gpt-oss-owned-continuation-unavailable' },
    });
    expect(generateWithModel).toHaveBeenCalledWith(expect.objectContaining({
      inputs: { input_ids: { data: BigInt64Array.from([10n, 11n, 12n]) } },
      pastKeyValues: null,
    }));
  });

  it('reports that cache reuse was unavailable when tool continuation has no PKV', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();
    const onInputPrepared = vi.fn();

    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never,
      tokenizer: tokenizer as never,
      messages: continuationMessages(),
      onChunk: vi.fn(),
      onToolCalls: vi.fn(),
      params: undefined,
      tools,
      pastKeyValues: undefined,
      stoppingCriteria,
      onInputPrepared,
      generateWithModel,
    });

    expect(callable).not.toHaveBeenCalled();
    expect(applyChatTemplate).toHaveBeenCalledOnce();
    expect(onInputPrepared).toHaveBeenCalledWith(expect.objectContaining({
      cacheDecision: { status: 'not-reused', reason: 'gpt-oss-owned-continuation-unavailable' },
    }));
    expect(generateWithModel).toHaveBeenCalledWith(expect.objectContaining({ pastKeyValues: null }));
  });

  it('keeps generation running when the diagnostic observer throws without PKV', async () => {
    const { tokenizer } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();
    const onInputPrepared = vi.fn(() => {
      throw new Error('diagnostic observer failed');
    });

    await expect(generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never,
      tokenizer: tokenizer as never,
      messages: continuationMessages(),
      onChunk: vi.fn(),
      onToolCalls: vi.fn(),
      params: undefined,
      tools,
      pastKeyValues: undefined,
      stoppingCriteria,
      onInputPrepared,
      generateWithModel,
    })).resolves.toBeUndefined();

    expect(onInputPrepared).toHaveBeenCalledOnce();
    expect(generateWithModel).toHaveBeenCalledOnce();
  });

  it('also rejects unowned supplied continuation when no diagnostic observer is installed', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();

    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never,
      tokenizer: tokenizer as never,
      messages: continuationMessages(),
      onChunk: vi.fn(),
      onToolCalls: vi.fn(),
      params: undefined,
      tools,
      pastKeyValues: { cached: true },
      stoppingCriteria,
      onInputPrepared: undefined,
      generateWithModel,
    });

    expect(callable).not.toHaveBeenCalled();
    expect(applyChatTemplate).toHaveBeenCalledOnce();
    expect(generateWithModel).toHaveBeenCalledWith(expect.objectContaining({ pastKeyValues: null }));
  });
});


describe('GPT-OSS content boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks(); streaming.callback = undefined;
  });

  it('renders every text-array item in order without interpreting literal tags or adding separators', async () => {
    const { tokenizer, applyChatTemplate } = tokenizerFixture();
    const id = toToolCallId({ raw: 'literal-history-call' });
    const messages: InferenceMessage[] = [
      { role: 'user', content: [{ type: 'text', text: '  First ' }, { type: 'text', text: 'Second🙂  ' }] },
      { role: 'assistant', content: [{ type: 'text', text: '<thi' }, { type: 'text', text: 'nk>R</think>A ' }],
        tool_calls: [{ id, type: 'function', function: { name: 'my_tool', arguments: ' { "x" : 1 } ' } }] },
      { role: 'tool', content: [{ type: 'text', text: 'Result ' }, { type: 'text', text: 'Result ' }], tool_call_id: id },
    ];
    const before = structuredClone(messages);
    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never, tokenizer: tokenizer as never, messages,
      onChunk: vi.fn(), onToolCalls: vi.fn(), params: undefined, tools: undefined,
      pastKeyValues: undefined, continuationOwner: undefined, stoppingCriteria, onInputPrepared: undefined,
      generateWithModel: generateWithModelFixture(),
    });
    expect(applyChatTemplate.mock.calls[0]?.[0]).toStrictEqual([
      { role: 'user', content: '  First Second🙂  ' },
      { role: 'assistant', content: '<think>R</think>A ', tool_calls: before[1]!.tool_calls },
      { role: 'tool', content: 'Result Result ', tool_call_id: 'literal-history-call' },
    ]);
    expect(messages).toStrictEqual(before);
  });

  it('rejects an image before calling the text-only template or generation', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();
    await expect(generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never, tokenizer: tokenizer as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep me' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
      onChunk: vi.fn(), onToolCalls: vi.fn(), params: undefined, tools: undefined,
      pastKeyValues: undefined, continuationOwner: undefined, stoppingCriteria, onInputPrepared: undefined,
      generateWithModel,
    })).rejects.toThrow('text-only');
    expect(applyChatTemplate).not.toHaveBeenCalled();
    expect(callable).not.toHaveBeenCalled();
    expect(generateWithModel).not.toHaveBeenCalled();
  });

  it.each([
    ' { "x" : 1e2, "text" : "\\u0041", "dup": 1, "dup": 2 }  ',
    '{} ',
  ])('preserves completed Harmony tool argument bytes: %s', async argumentsText => {
    const { tokenizer } = tokenizerFixture();
    const onToolCalls = vi.fn();
    const onChunk = vi.fn();
    const generateWithModel = vi.fn(async () => {
      const emit = streaming.callback!;
      for (const token of ['<|start|>', 'assistant to=functions.my_tool', '<|channel|>', 'commentary', '<|message|>', argumentsText]) emit(token);
      expect(onToolCalls).not.toHaveBeenCalled();
      emit('<|call|>');
      // Delivery waits for the native call to settle rather than starting a tool in its callback.
      expect(onToolCalls).not.toHaveBeenCalled();
      return { past_key_values: undefined };
    });
    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never, tokenizer: tokenizer as never, messages: [{ role: 'user', content: 'Use the tool' }],
      onChunk, onToolCalls, params: undefined, tools,
      pastKeyValues: undefined, continuationOwner: undefined, stoppingCriteria, onInputPrepared: undefined,
      generateWithModel,
    });
    expect(onToolCalls).toHaveBeenCalledOnce();
    expect(onToolCalls.mock.calls[0]?.[0]).toMatchObject({ toolCalls: [{ type: 'function', function: { name: 'my_tool', arguments: argumentsText } }] });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it.each(['{"unfinished":', '[]', 'null'])('does not manufacture a completed call for %s', async content => {
    const { tokenizer } = tokenizerFixture();
    const onToolCalls = vi.fn();
    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never, tokenizer: tokenizer as never, messages: [{ role: 'user', content: 'Tool' }],
      onChunk: vi.fn(), onToolCalls, params: undefined, tools,
      pastKeyValues: undefined, continuationOwner: undefined, stoppingCriteria, onInputPrepared: undefined,
      generateWithModel: vi.fn(async () => {
        const emit = streaming.callback!;
        for (const token of ['<|start|>', 'assistant to=functions.my_tool', '<|message|>', content, '<|call|>']) emit(token);
        return { past_key_values: undefined };
      }),
    });
    expect(onToolCalls).not.toHaveBeenCalled();
  });

  it('does not publish a valid JSON draft without its native call terminator', async () => {
    const { tokenizer } = tokenizerFixture();
    const onToolCalls = vi.fn();
    await generateGptOss({
      onGenerationEvent: undefined,
      model: {} as never, tokenizer: tokenizer as never, messages: [{ role: 'user', content: 'Tool' }],
      onChunk: vi.fn(), onToolCalls, params: undefined, tools,
      pastKeyValues: undefined, continuationOwner: undefined, stoppingCriteria, onInputPrepared: undefined,
      generateWithModel: vi.fn(async () => {
        const emit = streaming.callback!;
        for (const token of ['<|start|>', 'assistant to=functions.my_tool', '<|message|>', '{}']) emit(token);
        return { past_key_values: undefined };
      }),
    });
    expect(onToolCalls).not.toHaveBeenCalled();
  });

  it('uses the same unmodified text in a full prompt and an owned tool-result suffix', () => {
    const { tokenizer, callable } = tokenizerFixture();
    const id = toToolCallId({ raw: 'suffix-call' });
    const messages: InferenceMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'my_tool', arguments: '{}' } }] },
      { role: 'tool', content: [{ type: 'text', text: '<think>literal</think>' }, { type: 'text', text: '  🙂 ' }], tool_call_id: id },
    ];
    TEST_ONLY.buildGptOssToolResultTokens({ messages, tokenizer: tokenizer as never });
    expect(callable).toHaveBeenCalledWith('<|start|>my_tool to=assistant<|channel|>commentary<|message|><think>literal</think>  🙂 <|end|>', { add_special_tokens: false });
  });
});

describe('GPT-OSS structured reasoning input', () => {
  it('uses the native thinking field without deriving it from body tags', async () => {
    const { tokenizer, applyChatTemplate } = tokenizerFixture();
    const messages: InferenceMessage[] = [
      { role: 'assistant', content: '<think>literal</think>', reasoning: { text: '  R\n', completeness: 'complete' } },
      { role: 'user', content: 'next' },
    ];
    await generateGptOss({
      onGenerationEvent: undefined, model: {} as never, tokenizer: tokenizer as never, messages, onChunk: vi.fn(), onToolCalls: vi.fn(), params: undefined, tools: undefined, pastKeyValues: undefined, stoppingCriteria, onInputPrepared: undefined, generateWithModel: generateWithModelFixture() });
    expect(applyChatTemplate.mock.calls[0]?.[0]).toEqual([
      { role: 'assistant', content: '<think>literal</think>', thinking: '  R\n' },
      { role: 'user', content: 'next' },
    ]);
    expect(messages[0]?.reasoning?.text).toBe('  R\n');
  });

  it('preserves an explicitly empty reasoning field rather than dropping it by truthiness', async () => {
    const { tokenizer, applyChatTemplate } = tokenizerFixture();
    await generateGptOss({
      onGenerationEvent: undefined, model: {} as never, tokenizer: tokenizer as never, messages: [{ role: 'assistant', content: 'answer', reasoning: { text: '', completeness: 'complete' } }], onChunk: vi.fn(), onToolCalls: vi.fn(), params: undefined, tools: undefined, pastKeyValues: undefined, stoppingCriteria, onInputPrepared: undefined, generateWithModel: generateWithModelFixture() });
    expect(applyChatTemplate.mock.calls[0]?.[0]).toEqual([{ role: 'assistant', content: 'answer', thinking: '' }]);
  });

  it('rejects unfinished reasoning and reasoning plus a second body before tools, before tokenization', async () => {
    const { tokenizer, applyChatTemplate } = tokenizerFixture();
    const generate = generateWithModelFixture();
    for (const messages of [
      [{ role: 'assistant', content: '', reasoning: { text: 'R', completeness: 'partial' as const } }],
      [{ ...continuationMessages()[1]!, content: 'second body', reasoning: { text: 'R', completeness: 'complete' as const } }],
    ]) {
      await expect(generateGptOss({
        onGenerationEvent: undefined, model: {} as never, tokenizer: tokenizer as never, messages, onChunk: vi.fn(), onToolCalls: vi.fn(), params: undefined, tools: undefined, pastKeyValues: undefined, stoppingCriteria, onInputPrepared: undefined, generateWithModel: generate })).rejects.toThrow();
    }
    expect(applyChatTemplate).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});
