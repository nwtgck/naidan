// @vitest-environment node
import { expect, it } from 'vitest';
import { listChatModels } from './handlers';
import type { ReadOnlyInferenceResources } from './resources';

function resources({ models }: { models: { ref: string, label: string }[] }): ReadOnlyInferenceResources {
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
  const ref = `host/${encodeURIComponent('語'.repeat(255))}/owner/repo:${variant}`;
  const model = { ref, label: ref };
  const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [model] }), signal: new AbortController().signal }).getReader();
  expect(ref.length).toBeGreaterThan(1024);
  expect(await reader.read()).toEqual({ value: model, done: false });
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  reader.releaseLock();
});

it.each([
  'host/Models/owner/repo:',
  'host/Models/owner/repo:../Q4_K_M',
  'host/Models/owner/repo:nested//Q4_K_M',
  'host/Models/owner/repo:nested/./Q4_K_M',
  'host/Models/owner/repo:Q4_K_M\0',
  'host/Models/owner/repo:nested\\Q4_K_M',
])('rejects malformed public Host selectors: %s', async ref => {
  const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [{ ref, label: ref }] }), signal: new AbortController().signal }).getReader();
  await expect(reader.read()).rejects.toThrow();
  reader.releaseLock();
});

it('retains ordinary label bounds and rejects unknown catalog properties', async () => {
  for (const model of [{ ref: 'user/local', label: 'a'.repeat(1025) }, { ref: 'host/Models/owner/repo:model.gguf', label: 'Model', extra: true }]) {
    const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [model] }), signal: new AbortController().signal }).getReader();
    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
  }
});
