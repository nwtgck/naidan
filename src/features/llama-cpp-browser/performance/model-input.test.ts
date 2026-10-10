// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolvePerformanceModelInput } from './model-input';
const models = [{ id: 'user/b', name: 'B.gguf' }, { id: 'hf.co/org/repo:file.gguf', name: 'hf.co/org/repo:Q4_K_M' }];

describe('multiline saved-model input', () => {
  it('resolves IDs and names, trims CRLF and blanks, deduplicates, and preserves input order', () => {
    expect(resolvePerformanceModelInput({ text: [' hf.co/org/repo:Q4_K_M', '', 'B.gguf', 'user/b'].join('\r\n'), models, selected: [] })).toEqual({ selected: [models[1]!.id, models[0]!.id], errors: [] });
  });

  it('does not partially commit a list containing unresolved models or guess by basename', () => {
    const result = resolvePerformanceModelInput({
      text: `\
B.gguf
file.gguf`,
      models,
      selected: [],
    });
    expect(result.selected).toEqual([]); expect(result.errors[0]).toContain('Line 2');
  });

  it('requires exact identifiers for ambiguous names', () => {
    const candidates = [...models, { id: 'user/c', name: 'B.gguf' }];
    expect(resolvePerformanceModelInput({ text: 'B.gguf', models: candidates, selected: [] }).errors[0]).toContain('Ambiguous');
    expect(resolvePerformanceModelInput({ text: 'user/c', models: candidates, selected: [] }).selected).toEqual(['user/c']);
  });

  it('enforces list and input-size limits without modifying the old selection', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ id: String(i), name: `${i}.gguf` }));
    expect(resolvePerformanceModelInput({ text: many.map(m => m.id).join('\n'), models: many, selected: ['0'] })).toMatchObject({ selected: ['0'], errors: ['Select at most 16 models.'] });
    expect(resolvePerformanceModelInput({ text: 'a'.repeat(32769), models, selected: [] }).errors).toHaveLength(1);
  });
});
