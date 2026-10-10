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

it('streams the complete public Host ref and label without truncation or inference', async () => {
  const ref = `host/${encodeURIComponent('語'.repeat(255))}/owner/repo:nested%2Fmodel.gguf`;
  const model = { ref, label: ref };
  const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [model] }), signal: new AbortController().signal }).getReader();
  expect(ref.length).toBeGreaterThan(1024);
  expect(await reader.read()).toEqual({ value: model, done: false });
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  reader.releaseLock();
});

it('retains ordinary label bounds and rejects unknown catalog properties', async () => {
  for (const model of [{ ref: 'user/local', label: 'a'.repeat(1025) }, { ref: 'host/Models/owner/repo:model.gguf', label: 'Model', extra: true }]) {
    const reader = listChatModels({ input: {}, notify: {}, resources: resources({ models: [model] }), signal: new AbortController().signal }).getReader();
    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
  }
});
