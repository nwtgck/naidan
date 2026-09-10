import { describe, expect, it, vi } from 'vitest';
import { buildQwen3_5Prompt, normalizeQwen3_5ProcessorInputs, type Qwen3_5TemplateRenderer } from './qwen3_5';
import { toToolCallId } from '@/01-models/ids';

describe('Qwen native template delegation', () => {
  it('leaves unspecified thinking absent and preserves the native template output exactly', () => {
    const apply_chat_template = vi.fn<Qwen3_5TemplateRenderer['apply_chat_template']>(() => 'native template including its own suffix');
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const result = buildQwen3_5Prompt({ messages, tools: undefined, reasoningMode: 'default', tokenizer: { apply_chat_template } });
    expect(apply_chat_template).toHaveBeenCalledExactlyOnceWith(messages, { tokenize: false, add_generation_prompt: true });
    expect(Object.hasOwn(apply_chat_template.mock.calls[0]![1]!, 'enable_thinking')).toBe(false);
    expect(result).toBe('native template including its own suffix');
  });

  it('passes explicit disabled thinking without adding a second newline', () => {
    const apply_chat_template = vi.fn(() => `\
<think>

</think>

`);
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(buildQwen3_5Prompt({ messages, tools: undefined, reasoningMode: 'disabled', tokenizer: { apply_chat_template } })).toBe(`\
<think>

</think>

`);
    expect(apply_chat_template).toHaveBeenCalledExactlyOnceWith(messages, { tokenize: false, add_generation_prompt: true, enable_thinking: false });
  });

  it('passes explicit enabled thinking without adding a second newline', () => {
    const apply_chat_template = vi.fn(() => '<think>\n');
    const messages = [{ role: 'user' as const, content: 'hello' }];
    expect(buildQwen3_5Prompt({ messages, tools: undefined, reasoningMode: 'enabled', tokenizer: { apply_chat_template } })).toBe('<think>\n');
    expect(apply_chat_template).toHaveBeenCalledExactlyOnceWith(messages, { tokenize: false, add_generation_prompt: true, enable_thinking: true });
  });

  it('passes one system message and supplied assistant history to the native renderer', () => {
    const apply_chat_template = vi.fn(() => 'native system and history');
    const messages = [
      { role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' }, { role: 'user' as const, content: 'next' },
    ];
    expect(buildQwen3_5Prompt({ messages, tools: undefined, reasoningMode: 'default', tokenizer: { apply_chat_template } })).toBe('native system and history');
    expect(apply_chat_template).toHaveBeenCalledExactlyOnceWith(messages, { tokenize: false, add_generation_prompt: true });
  });

  it('normalizes string arguments to the native dictionary grammar without losing tool IDs or value types', () => {
    const apply_chat_template = vi.fn(() => 'native tool history');
    const id = toToolCallId({ raw: 'call_1' });
    const tools = [{ type: 'function' as const, function: { name: 'lookup', description: 'Synthetic tool.', parameters: { type: 'object' } } }];
    const messages = [
      { role: 'user' as const, content: 'lookup' },
      { role: 'assistant' as const, content: 'checking', tool_calls: [{ id, type: 'function' as const, function: { name: 'lookup', arguments: '{"text":"12","count":12,"flag":false,"nested":{"x":[1,2]}}' } }] },
      { role: 'tool' as const, tool_call_id: id, content: 'result' },
    ];
    buildQwen3_5Prompt({ messages, tools, reasoningMode: 'default', tokenizer: { apply_chat_template } });
    expect(apply_chat_template).toHaveBeenCalledExactlyOnceWith([
      messages[0], { ...messages[1], tool_calls: [{ id, type: 'function', function: { name: 'lookup', arguments: { text: '12', count: 12, flag: false, nested: { x: [1, 2] } } } }] }, messages[2],
    ], { tokenize: false, add_generation_prompt: true, tools });
    expect(messages[1]!.tool_calls![0]!.function.arguments).toBe('{"text":"12","count":12,"flag":false,"nested":{"x":[1,2]}}');
  });

  it('keeps fresh image tensors instead of deleting them as if their features were already cached', () => {
    const pixels = { tensor: 'actual-processor-pixels' };
    const grid = { tensor: 'actual-processor-grid' };
    const input = { input_ids: {}, pixel_values: pixels, image_grid_thw: grid };
    const result = normalizeQwen3_5ProcessorInputs({ inputs: input });
    expect(result).toStrictEqual(input);
    expect(result.pixel_values).toBe(pixels);
    expect(result.image_grid_thw).toBe(grid);
  });
});
