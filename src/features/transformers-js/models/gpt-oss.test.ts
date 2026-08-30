import { describe, expect, it, vi } from 'vitest';

vi.mock('@huggingface/transformers', () => ({
  TextStreamer: class {
    constructor() {}
  },
}));

import { toToolCallId } from '@/01-models/ids';
import { generateGptOss } from './gpt-oss';

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
  it('reports reconstructed full input and cache reuse for an observed tool continuation', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();
    const onInputPrepared = vi.fn();
    const pastKeyValues = { cached: true };

    await generateGptOss({
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

    expect(callable).toHaveBeenCalledWith(
      expect.stringContaining('<|start|>my_tool to=assistant'),
      expect.objectContaining({ add_special_tokens: false }),
    );
    expect(applyChatTemplate).toHaveBeenCalledOnce();
    expect(onInputPrepared).toHaveBeenCalledWith({
      fullConversationInputs: { input_ids: { data: BigInt64Array.from([10n, 11n, 12n]) } },
      cacheDecision: { status: 'reused', reason: 'gpt-oss-tool-continuation' },
    });
    expect(generateWithModel).toHaveBeenCalledWith(expect.objectContaining({
      inputs: { input_ids: { data: BigInt64Array.from([90n, 91n]) } },
      pastKeyValues,
    }));
  });

  it('reports that cache reuse was unavailable when tool continuation has no PKV', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();
    const onInputPrepared = vi.fn();

    await generateGptOss({
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
      cacheDecision: { status: 'not-reused', reason: 'gpt-oss-past-key-values-unavailable' },
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
    })).resolves.toBeDefined();

    expect(onInputPrepared).toHaveBeenCalledOnce();
    expect(generateWithModel).toHaveBeenCalledOnce();
  });

  it('does not add diagnostic full-prompt rendering to the normal unobserved continuation path', async () => {
    const { tokenizer, applyChatTemplate, callable } = tokenizerFixture();
    const generateWithModel = generateWithModelFixture();

    await generateGptOss({
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

    expect(callable).toHaveBeenCalledOnce();
    expect(applyChatTemplate).not.toHaveBeenCalled();
  });
});
