// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolvePerformanceModelInput } from './model-input';
const models = [{ modelId: 'user/b' }, { modelId: 'hf.co/org/repo:Q4_K_M' }];

describe('multiline saved-model input', () => {
  it('resolves modelIds, trims CRLF and blanks, deduplicates, and preserves input order', () => {
    expect(resolvePerformanceModelInput({ text: [' hf.co/org/repo:Q4_K_M', '', 'user/b', 'user/b'].join('\r\n'), models, selected: [] })).toEqual({ selected: [models[1]!.modelId, models[0]!.modelId], errors: [] });
  });

  it('does not partially commit a list containing unresolved models or guess by basename', () => {
    const result = resolvePerformanceModelInput({
      text: `\
user/b
file.gguf`,
      models,
      selected: [],
    });
    expect(result.selected).toEqual([]);
    expect(result.errors[0]).toContain('Line 2');
  });

  it('rejects ambiguous modelIds instead of choosing an entry', () => {
    const candidates = [...models, { modelId: 'user/b' }];
    expect(resolvePerformanceModelInput({ text: 'user/b', models: candidates, selected: [] }).errors[0]).toContain('Ambiguous');
    expect(resolvePerformanceModelInput({ text: models[1]!.modelId, models: candidates, selected: [] }).selected).toEqual([models[1]!.modelId]);
  });

  it('enforces list and input-size limits without modifying the old selection', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ modelId: String(i) }));
    expect(resolvePerformanceModelInput({ text: many.map(m => m.modelId).join('\n'), models: many, selected: ['0'] })).toMatchObject({ selected: ['0'], errors: ['Select at most 16 models.'] });
    expect(resolvePerformanceModelInput({ text: 'a'.repeat(32769), models, selected: [] }).errors).toHaveLength(1);
  });
});
