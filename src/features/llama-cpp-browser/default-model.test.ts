import { describe, expect, it } from 'vitest';
import { displayedLocalModelDefault } from './default-model';

const current = { endpoint: { type: 'llama_cpp_browser' as const }, modelId: 'user/Repo' };
const model = { modelId: 'user/Repo/Model-Q4', size: 32, importedAt: 1 };

describe('saved local default presentation', () => {
  it('recognizes an existing single-model root without changing its persisted default', () => {
    expect(displayedLocalModelDefault({ current, models: [model] })?.modelId).toBe('user/Repo/Model-Q4');
    expect(current.modelId).toBe('user/Repo');
  });

  it('does not guess a variant in an ambiguous repository or a matching API name', () => {
    expect(displayedLocalModelDefault({ current, models: [model, { ...model, modelId: 'user/Repo/Model-Q8' }] })).toBe(current);
    const api = { endpoint: { type: 'openai' as const, url: '' }, modelId: current.modelId };
    expect(displayedLocalModelDefault({ current: api, models: [model] })).toBe(api);
  });
});
