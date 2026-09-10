import { describe, expect, it } from 'vitest';
import {
  isQwen3_5Model,
  assessQwen3_5NoToolContinuationEligibility,
  normalizeQwen3_5ToolCallsForTemplate,
  normalizeQwen3_5ProcessorInputs,
} from './qwen3_5';
import { toToolCallId } from '@/01-models/ids';
import type { ChatMessage } from '@/01-models/types';

// Historical comparisons only: neither helper is part of current Production.
// Real-path tests separately require one full native render and no retry.
function historicalRetryDecision({ error, isQwen3_5ToolContinuation }: { error: unknown; isQwen3_5ToolContinuation: boolean }): boolean {
  return isQwen3_5ToolContinuation && error instanceof Error && error.message.includes("Cannot read properties of undefined (reading 'inputNames')");
}
function historicalToolContinuation({ promptHistory, messages }: { promptHistory: string; messages: ChatMessage[] }): string {
  const history = promptHistory.endsWith('\n') ? promptHistory.slice(0, -1) : promptHistory;
  const results = messages.filter(message => message.role === 'tool').map(message => `<tool_response>\n${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}\n</tool_response>`).join('\n');
  return `${history}\n${results}\n<|im_start|>assistant\n<think>\n`;
}

describe('transformers-js-qwen3_5', () => {
  it('detects Qwen3.5 from model type or model id', () => {
    expect(isQwen3_5Model({
      modelType: 'qwen3_5',
      activeModelId: null,
    })).toBe(true);

    expect(isQwen3_5Model({
      modelType: undefined,
      activeModelId: 'hf.co/onnx-community/Qwen3.5-2B-ONNX',
    })).toBe(true);

    expect(isQwen3_5Model({
      modelType: 'llama',
      activeModelId: 'hf.co/meta-llama/Llama-3.2-3B-Instruct',
    })).toBe(false);
  });

  it('recognizes the assistant plus next user shape without claiming token-prefix or cache validity', () => {
    const decision = assessQwen3_5NoToolContinuationEligibility({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'again' },
      ],
      conversationState: {
        modelId: 'hf.co/onnx-community/Qwen3.5-2B-ONNX',
        messageCount: 1,
      },
      activeModelId: 'hf.co/onnx-community/Qwen3.5-2B-ONNX',
    });

    expect(decision).toEqual({
      status: 'eligible',
    });
  });

  it('normalizes JSON-string tool arguments to objects for the chat template', () => {
    const normalized = normalizeQwen3_5ToolCallsForTemplate({
      toolCalls: [
        {
          id: toToolCallId({ raw: 'call_1' }),
          type: 'function',
          function: {
            name: 'shell_execute',
            arguments: '{"shell_script":"ls -la","stdout_limit":100}',
          },
        },
      ],
    });

    expect(normalized[0]?.function.arguments).toEqual({
      shell_script: 'ls -la',
      stdout_limit: 100,
    });
  });

  it('rejects adjacent users as a continuation rather than reusing an unrelated cache', () => {
    expect(assessQwen3_5NoToolContinuationEligibility({
      messages: [{ role: 'user', content: 'first' }, { role: 'user', content: 'next' }],
      conversationState: { modelId: 'synthetic', messageCount: 1 }, activeModelId: 'synthetic',
    })).toEqual({ status: 'ineligible', reason: 'message-count-mismatch' });
  });

  it('requires the inserted assistant role even when the message count matches', () => {
    expect(assessQwen3_5NoToolContinuationEligibility({
      messages: [{ role: 'user', content: 'first' }, { role: 'system', content: 'not an assistant' }, { role: 'user', content: 'next' }],
      conversationState: { modelId: 'synthetic', messageCount: 1 }, activeModelId: 'synthetic',
    })).toEqual({ status: 'ineligible', reason: 'preceding-message-is-not-assistant' });
  });

  it('preserves a JSON argument named __proto__ while normalizing native dictionaries', () => {
    const normalized = normalizeQwen3_5ToolCallsForTemplate({ toolCalls: [{
      id: toToolCallId({ raw: 'synthetic-proto' }), type: 'function', function: { name: 'lookup', arguments: '{"__proto__":{"city":"Tokyo"}}' },
    }] });
    expect(JSON.stringify(normalized[0]!.function.arguments)).toBe('{"__proto__":{"city":"Tokyo"}}');
    expect(Object.getPrototypeOf(normalized[0]!.function.arguments)).toBe(Object.prototype);
  });

  it('removes null multimodal keys from continuation inputs', () => {
    const mergedInputs = normalizeQwen3_5ProcessorInputs({
      inputs: {
        input_ids: [1, 2, 3],
        attention_mask: [1, 1, 1],
        pixel_values: null,
        image_grid_thw: null,
      },
    });

    expect(mergedInputs).not.toHaveProperty('pixel_values');
    expect(mergedInputs).not.toHaveProperty('image_grid_thw');
  });

  it('retains the historical crash retry classifier only as a test-local comparison', () => {
    expect(historicalRetryDecision({
      error: new TypeError("Cannot read properties of undefined (reading 'inputNames')"),
      isQwen3_5ToolContinuation: true,
    })).toBe(true);

    expect(historicalRetryDecision({
      error: new Error('some other failure'),
      isQwen3_5ToolContinuation: true,
    })).toBe(false);
  });

  it('retains the historical decoded-history tool suffix only as a test-local comparison', () => {
    const prompt = historicalToolContinuation({
      promptHistory: `\
<|im_start|>user
hello<|im_end|>
<|im_start|>assistant
<think>

</think>

<tool_call>...</tool_call>`,
      messages: [
        {
          role: 'tool',
          tool_call_id: toToolCallId({ raw: 'call_1' }),
          content: 'Exit Code: 0',
        },
      ],
    });

    expect(prompt).toContain('<tool_call>...</tool_call>');
    expect(prompt).toContain(`\
<tool_response>
Exit Code: 0
</tool_response>`);
    expect(prompt).toContain(`\
<|im_start|>assistant
<think>
`);
  });
});
