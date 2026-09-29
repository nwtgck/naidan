import { describe, expect, it } from 'vitest';
import { localModelDisplayName } from '@/features/llama-cpp-browser/default-model';
import { groupModelFiles } from './catalog';
import { modelSuggestions, preferredQuantizationHint, suggestedQuantizationLabel, suggestionDownloadKey } from './model-suggestions';
import { findLocalSuggestedModel, resolveSuggestionPlan, SuggestionPlanError } from './suggestion-plan';

const gemma = modelSuggestions.find(suggestion => suggestion.id === 'gemma-4-e2b')!;
const qat = gemma.quantizationHints.find(choice => choice.checkpoint === 'qat')!;
const q4 = gemma.quantizationHints.find(choice => choice.preferredQuantization === 'Q4_K_M')!;
const q8 = gemma.quantizationHints.find(choice => choice.preferredQuantization === 'Q8_0')!;
const revision = 'a'.repeat(40);

describe('static quantization intent', () => {
  it('prefers QAT, then Q4_K_M, then the explicit first choice, independently of menu order', () => {
    expect(preferredQuantizationHint({ suggestion: { ...gemma, quantizationHints: [q8, q4, qat] } })).toBe(qat);
    expect(preferredQuantizationHint({ suggestion: { ...gemma, quantizationHints: [q8, q4] } })).toBe(q4);
    expect(preferredQuantizationHint({ suggestion: { ...gemma, quantizationHints: [q8] } })).toBe(q8);
    const gpt = modelSuggestions.find(suggestion => suggestion.id === 'gpt-oss-20b')!;
    expect(gpt.quantizationHints.map(choice => choice.preferredQuantization)).toEqual(['MXFP4']);
    expect(preferredQuantizationHint({ suggestion: gpt }).preferredQuantization).toBe('MXFP4');
  });

  it('labels QAT as a checkpoint property, not as a fake GGUF token or a permanent model-name suffix', () => {
    expect(gemma.name).toBe('Gemma 4 E2B it');
    expect(qat.preferredQuantization).toBe('Q4_0');
    expect(suggestedQuantizationLabel({ quantization: qat })).toBe('Q4_0 (QAT)');
    expect(suggestedQuantizationLabel({ quantization: q4 })).toBe('Q4_K_M');
  });

  it('gives every row unique, explicit source choices and keeps estimates outside download identity', () => {
    for (const suggestion of modelSuggestions) {
      expect(new Set(suggestion.quantizationHints.map(choice => choice.id)).size).toBe(suggestion.quantizationHints.length);
      for (const quantization of suggestion.quantizationHints) {
        expect(quantization.repository).toMatch(/^[^/]+\/[^/]+$/);
        const key = suggestionDownloadKey({ suggestionId: suggestion.id, quantization, multimodal: 'off' });
        expect(key).not.toBe(suggestionDownloadKey({ suggestionId: suggestion.id, quantization, multimodal: 'on' }));
        expect(key).not.toBe(suggestionDownloadKey({ suggestionId: suggestion.id, quantization: { ...quantization, repository: 'another/source' }, multimodal: 'off' }));
        expect(key).toBe(suggestionDownloadKey({ suggestionId: suggestion.id, quantization: { ...quantization, approximateModelBytes: 1, approximateMultimodalBytes: 2 }, multimodal: 'off' }));
      }
    }
    expect(suggestionDownloadKey({ suggestionId: gemma.id, quantization: qat, multimodal: 'off' })).not.toBe(suggestionDownloadKey({ suggestionId: gemma.id, quantization: q4, multimodal: 'off' }));
  });

  it('never falls back to a community source or a different token when the requested checkpoint is absent', () => {
    const main = { path: 'gemma-4-E2B_q4_0-it.gguf', size: 17 };
    const googleCatalog = { repository: qat.repository, revision, ...groupModelFiles({ files: [main] }) };
    const sameTokenOtherSource = { ...qat, repository: q4.repository, checkpoint: 'standard' as const };
    expect(() => resolveSuggestionPlan({ quantization: sameTokenOtherSource, catalog: googleCatalog, multimodal: 'off' })).toThrow(SuggestionPlanError);
    expect(() => resolveSuggestionPlan({ quantization: q4, catalog: { ...googleCatalog, repository: q4.repository }, multimodal: 'off' })).toThrow(SuggestionPlanError);
    const local = { id: `hf.co/${qat.repository}:${encodeURIComponent(main.path)}`, name: main.path, size: main.size, importedAt: 1 };
    expect(findLocalSuggestedModel({ quantization: sameTokenOtherSource, models: [local] })).toBeUndefined();
    expect(localModelDisplayName({ model: local })).toBe('Gemma 4 E2B it · Q4_0 (QAT)');
    const community = { ...local, id: `hf.co/${q4.repository}:gemma-4-E2B-it-Q4_K_M.gguf` };
    expect(localModelDisplayName({ model: community })).toBe('Gemma 4 E2B it · Q4_K_M');
  });
});

// Synthetic sizes/filenames deliberately do not equal the bundled hints: the
// requested token/source must resolve against discovered data, not a file allowlist.
describe.each(modelSuggestions.flatMap(suggestion => suggestion.quantizationHints.map(quantization => ({ suggestion, quantization, title: `${suggestion.id}/${quantization.id}` }))))('$title resolution', ({ suggestion, quantization }) => {
  it('resolves only the requested main token and same-repository projector using discovered sizes', () => {
    const main = { path: `updated-name-${quantization.preferredQuantization}.gguf`, size: 128 };
    const projector = { path: 'mmproj-updated-name-F16.gguf', size: 96 };
    const other = { path: `dflash-updated-name-${quantization.preferredQuantization}.gguf`, size: 64 };
    const catalog = { repository: quantization.repository, revision, ...groupModelFiles({ files: [projector, other, main] }) };
    expect(resolveSuggestionPlan({ quantization, catalog, multimodal: 'off' })).toEqual({ repository: quantization.repository, revision, files: [main] });
    expect(resolveSuggestionPlan({ quantization, catalog, multimodal: 'on' }).files).toEqual([main, projector]);
    const local = { id: `hf.co/${quantization.repository}:${encodeURIComponent(main.path)}`, name: main.path, size: main.size, importedAt: 1 };
    expect(findLocalSuggestedModel({ quantization, models: [local] })).toBe(local);
    expect(localModelDisplayName({ model: local })).toBe(`${suggestion.name} · ${suggestedQuantizationLabel({ quantization })}`);
    expect(() => resolveSuggestionPlan({ quantization, catalog: { ...catalog, ...groupModelFiles({ files: [main, { ...main, path: `another-${main.path}` }] }) }, multimodal: 'off' })).toThrow(SuggestionPlanError);
  });
});
