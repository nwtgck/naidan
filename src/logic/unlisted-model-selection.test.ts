import { expect, it } from 'vitest';
import type { Endpoint } from '@/01-models/types';
import { preservesUnlistedModel } from './unlisted-model-selection';

it.each<Endpoint>([{ type: 'llama_cpp_browser' }, { type: 'naidan_rpc', registrationId: undefined }])('retains missing temporary names on $type without imposing identity guarantees', endpoint => {
  expect(preservesUnlistedModel({ endpoint, modelId: 'temp/Models' })).toBe(true);
  expect(preservesUnlistedModel({ endpoint, modelId: 'temp/Models/owner/repo:subdir%2Fmodel.gguf' })).toBe(true);
  expect(preservesUnlistedModel({ endpoint, modelId: 'ordinary-missing-model' })).toBe(false);
});

it('does not change the missing-model policy of unrelated providers', () => {
  expect(preservesUnlistedModel({ endpoint: { type: 'openai', url: 'https://example.invalid/' }, modelId: 'temp/Models' })).toBe(false);
});
