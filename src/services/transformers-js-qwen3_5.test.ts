import { describe, expect, it } from 'vitest';
import {
  applyQwen3_5ContinuationState,
  buildQwen3_5ToolContinuationPrompt,
  isQwen3_5Model,
  normalizeQwen3_5ToolCallsForTemplate,
  shouldRetryQwen3_5WithoutContinuation,
} from './transformers-js-qwen3_5';

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

  it('normalizes JSON-string tool arguments to objects for the chat template', () => {
    const normalized = normalizeQwen3_5ToolCallsForTemplate({
      toolCalls: [
        {
          id: 'call_1',
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

  it('removes null multimodal keys from continuation inputs', () => {
    const mergedInputs = applyQwen3_5ContinuationState({
      inputs: {
        input_ids: [1, 2, 3],
        attention_mask: [1, 1, 1],
        pixel_values: null,
        image_grid_thw: null,
      },
      continuationState: {
        modelId: 'hf.co/onnx-community/Qwen3.5-2B-ONNX',
        pastKeyValues: {},
        imageGridThw: undefined,
        videoGridThw: undefined,
      },
    });

    expect(mergedInputs).not.toHaveProperty('pixel_values');
    expect(mergedInputs).not.toHaveProperty('image_grid_thw');
  });

  it('retries only for the known transformers.js continuation crash', () => {
    expect(shouldRetryQwen3_5WithoutContinuation({
      error: new TypeError("Cannot read properties of undefined (reading 'inputNames')"),
      isQwen3_5ToolContinuation: true,
    })).toBe(true);

    expect(shouldRetryQwen3_5WithoutContinuation({
      error: new Error('some other failure'),
      isQwen3_5ToolContinuation: true,
    })).toBe(false);
  });

  it('builds tool continuation prompts from the previously decoded history', () => {
    const prompt = buildQwen3_5ToolContinuationPrompt({
      promptHistory: '<|im_start|>user\nhello<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n<tool_call>...</tool_call>',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'Exit Code: 0',
        },
      ],
    });

    expect(prompt).toContain('<tool_call>...</tool_call>');
    expect(prompt).toContain('<tool_response>\nExit Code: 0\n</tool_response>');
    expect(prompt).toContain('<|im_start|>assistant\n<think>\n');
  });
});
