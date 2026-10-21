// @vitest-environment node
import { expect, it } from 'vitest';
import { listChatModels } from './handlers';
import type { ReadOnlyInferenceResources } from './resources';

function resources({ models }: { models: { modelId: string }[] }): ReadOnlyInferenceResources {
  const unavailable = (): never => {
    throw new Error('Unexpected inference');
  };
  return { listChatModels: async () => models, listImageModels: unavailable, generateChat: unavailable, generateImage: unavailable };
}

it.each([
  { kind: 'short variant', variant: 'Q4_K_M' },
  { kind: 'meaningful directory', variant: 'nested/Q4_K_M' },
  { kind: 'split model short variant', variant: 'UD-Q4_K_XL' },
  { kind: 'exact relative path', variant: 'nested/model.gguf' },
  { kind: 'literal percent filename', variant: '..%2FQ4_K_M' },
  { kind: 'literal percent filename', variant: 'nested%2F%2FQ4_K_M' },
  { kind: 'literal percent filename', variant: 'Q4_K_M%00' },
  { kind: 'literal percent filename', variant: 'Q4_K_M%' },
])('streams the complete $kind $variant without truncation, decoding or inference', async ({ variant }) => {
  const modelId = `host/${encodeURIComponent('語'.repeat(255))}/owner/repo:${variant}`;
  const model = { modelId };
  const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [model] }), signal: new AbortController().signal }).getReader();
  expect(modelId.length).toBeGreaterThan(1024);
  expect(await reader.read()).toEqual({ value: model, done: false });
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  reader.releaseLock();
});

it.each([
  'host/MyModels1/owner/repo:',
  'host/MyModels1/owner/repo:../Q4_K_M',
  'host/MyModels1/owner/repo:nested//Q4_K_M',
  'host/MyModels1/owner/repo:nested/./Q4_K_M',
  'host/MyModels1/owner/repo:Q4_K_M\0',
  'host/MyModels1/owner/repo:nested\\Q4_K_M',
])('returns Host strings without interpreting or decoding them: %s', async modelId => {
  const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [{ modelId }] }), signal: new AbortController().signal }).getReader();
  expect(await reader.read()).toEqual({ value: { modelId }, done: false });
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  reader.releaseLock();
});

it('rejects unknown catalog properties while accepting modelId strings structurally', async () => {
  for (const model of [{ modelId: 'user/local', label: 'Local' }, { modelId: 'host/MyModels1/owner/repo:model.gguf', extra: true }]) {
    const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [model] }), signal: new AbortController().signal }).getReader();
    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
  }
});
