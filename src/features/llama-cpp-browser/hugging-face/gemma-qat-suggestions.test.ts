import { describe, expect, it } from 'vitest';
import { groupModelFiles } from './catalog';
import { modelSuggestions, preferredQuantizationHint } from './model-suggestions';
import { quantizationName } from './presentation';
import { findLocalSuggestedModel, resolveSuggestionPlan, SuggestionPlanError } from './suggestion-plan';
import { localModelDisplayName } from '@/features/llama-cpp-browser/default-model';

// Observed Google repository paths, reviewed 2026-09-22. These are regression
// fixtures, not a production filename allowlist. In particular, Google's main
// files use an interior lowercase _q4_0 token and mmproj has no quantization tag.
const cases = [
  {
    id: 'gemma-4-e2b', name: 'Gemma 4 E2B it',
    repository: 'google/gemma-4-E2B-it-qat-q4_0-gguf',
    previousRepository: 'lmstudio-community/gemma-4-E2B-it-GGUF',
    mainPath: 'gemma-4-E2B_q4_0-it.gguf', projectorPath: 'gemma-4-E2B-it-mmproj.gguf',
    approximateModelBytes: 3_350_000_000, approximateMultimodalBytes: 987_000_000,
    suggestedMemoryGiB: 8, suggestedMultimodalMemoryGiB: 16,
  },
  {
    id: 'gemma-4-e4b', name: 'Gemma 4 E4B it',
    repository: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
    previousRepository: 'lmstudio-community/gemma-4-E4B-it-GGUF',
    mainPath: 'gemma-4-E4B_q4_0-it.gguf', projectorPath: 'gemma-4-E4B-it-mmproj.gguf',
    approximateModelBytes: 5_150_000_000, approximateMultimodalBytes: 992_000_000,
    suggestedMemoryGiB: 16, suggestedMultimodalMemoryGiB: 16,
  },
  {
    id: 'gemma-4-26b', name: 'Gemma 4 26B-A4B it',
    repository: 'google/gemma-4-26B-A4B-it-qat-q4_0-gguf',
    previousRepository: 'lmstudio-community/gemma-4-26B-A4B-it-GGUF',
    mainPath: 'gemma-4-26B_q4_0-it.gguf', projectorPath: 'gemma-4-26B-it-mmproj.gguf',
    approximateModelBytes: 14_400_000_000, approximateMultimodalBytes: 1_190_000_000,
    suggestedMemoryGiB: 32, suggestedMultimodalMemoryGiB: 32,
  },
];

describe.each(cases)('Gemma QAT suggestion $id', fixture => {
  const suggestion = modelSuggestions.find(entry => entry.id === fixture.id)!;
  const quantization = preferredQuantizationHint({ suggestion });
  // Synthetic sizes intentionally differ from static hints. Exact download
  // selections must continue to use discovered bytes, not the bundled estimates.
  const main = { path: fixture.mainPath, size: 128 };
  const projector = { path: fixture.projectorPath, size: 96 };
  const catalog = { repository: fixture.repository, revision: 'a'.repeat(40), ...groupModelFiles({ files: [projector, main] }) };

  it('uses the official QAT source and refreshed size hints without changing memory tiers', () => {
    expect(suggestion).toMatchObject({ id: fixture.id, name: fixture.name, developer: 'Google' });
    expect(quantization).toEqual({
      id: 'qat-q4_0', checkpoint: 'qat',
      repository: fixture.repository, preferredQuantization: 'Q4_0',
      approximateModelBytes: fixture.approximateModelBytes,
      approximateMultimodalBytes: fixture.approximateMultimodalBytes,
      suggestedMemoryGiB: fixture.suggestedMemoryGiB,
      suggestedMultimodalMemoryGiB: fixture.suggestedMultimodalMemoryGiB,
    });
  });

  it('resolves the real main filename and only adds the same-repository projector when requested', () => {
    expect(quantizationName({ path: fixture.mainPath })).toBe('Q4_0');
    expect(quantizationName({ path: fixture.projectorPath })).toBeUndefined();
    expect(resolveSuggestionPlan({ quantization, catalog, multimodal: 'off' })).toEqual({ repository: fixture.repository, revision: catalog.revision, files: [main] });
    expect(resolveSuggestionPlan({ quantization, catalog, multimodal: 'on' })).toEqual({ repository: fixture.repository, revision: catalog.revision, files: [main, projector] });
  });

  it('does not treat a previous non-QAT installation or another repository as the QAT checkpoint', () => {
    const local = { id: `hf.co/${fixture.repository}:${encodeURIComponent(fixture.mainPath)}`, name: fixture.mainPath, size: 128, importedAt: 1 };
    const previous = { ...local, id: `hf.co/${fixture.previousRepository}:model-Q4_K_M.gguf` };
    const anotherSource = { ...local, id: `hf.co/${fixture.previousRepository}:${encodeURIComponent(fixture.mainPath)}` };
    expect(findLocalSuggestedModel({ quantization, models: [previous, anotherSource] })).toBeUndefined();
    expect(findLocalSuggestedModel({ quantization, models: [previous, local] })).toEqual(local);
    expect(localModelDisplayName({ model: local })).toBe(`${fixture.name} · Q4_0 (QAT)`);
    expect(localModelDisplayName({ model: previous })).toBe(`${fixture.name} · Q4_K_M`);
    expect(() => resolveSuggestionPlan({ quantization, catalog: { ...catalog, repository: fixture.previousRepository }, multimodal: 'off' })).toThrow(SuggestionPlanError);
  });
});
