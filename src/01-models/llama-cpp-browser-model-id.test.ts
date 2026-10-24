import { expect, it } from 'vitest';
import { formatHuggingFaceModelId } from './llama-cpp-browser-model-id';

it.each([
  ['Chat-Q4.gguf', 'Q4'],
  ['Q4/Chat-Q4-00001-of-00002.gguf', 'Q4'],
  ['imatrix/Chat-Q4.gguf', 'imatrix/Q4'],
  ['Chat-Q A.gguf', 'Q A'],
  ['Chat-Q%20A.gguf', 'Q%20A'],
  ['.gguf', '.gguf'],
])('uses the same readable modelId before download for %s', (mainFilePath, variant) => {
  expect(formatHuggingFaceModelId({ repository: 'owner/Chat-GGUF', mainFilePath })).toBe(`hf.co/owner/Chat-GGUF:${variant}`);
});

it.each(['../model.gguf', '/model.gguf', 'a//b.gguf', 'a\\b.gguf', 'model.safetensors'])('rejects unsafe or unsupported remote model path %s', mainFilePath => {
  expect(() => formatHuggingFaceModelId({ repository: 'owner/Chat-GGUF', mainFilePath })).toThrow();
});
