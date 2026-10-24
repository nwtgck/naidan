import { expect, it } from 'vitest';
import { modelSuggestions } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { localModelDisplayName, matchesSuggestedBrowserModel } from './browser-model-presentation';

it('matches the repository and complete quantization instead of a similar display name', () => {
  const hint = modelSuggestions.find(model => model.id === 'gemma-4-e2b')!.quantizationHints.find(hint => hint.id === 'q4_k_m')!;
  expect(matchesSuggestedBrowserModel({ model: { modelId: `hf.co/${hint.hfRepository}:Gemma-Q4_K_M`, source: undefined }, hint })).toBe(true);
  expect(matchesSuggestedBrowserModel({ model: { modelId: `hf.co/${hint.hfRepository}:Gemma-Q4_K_M_EXTRA`, source: undefined }, hint })).toBe(false);
  expect(matchesSuggestedBrowserModel({ model: { modelId: 'hf.co/another/Gemma-GGUF:Q4_K_M', source: undefined }, hint })).toBe(false);
  expect(matchesSuggestedBrowserModel({ model: { modelId: `hf.co/${hint.hfRepository}`, source: undefined }, hint })).toBe(false);
});

it.each([
  { modelId: 'hf.co/owner/Model-120B-GGUF:Q8_0', name: 'Model-120B-GGUF:Q8_0' },
  { modelId: 'host/Library/owner/Model-120B-GGUF:Q4_K_M', name: 'Model-120B-GGUF:Q4_K_M' },
  { modelId: 'temp/Model-120B:Q4_K_M', name: 'Model-120B:Q4_K_M' },
  { modelId: 'temp/Folder/owner/Model-120B-GGUF:Q8_0', name: 'Model-120B-GGUF:Q8_0' },
  { modelId: 'hf.co/owner/Model-120B-GGUF:quant/Model-120B-Q8_0.gguf', name: 'Model-120B-Q8_0' },
])('preserves the complete model size and selector in $modelId without inventory source metadata', ({ modelId, name }) => {
  expect(localModelDisplayName({ model: { modelId } })).toBe(name);
});
