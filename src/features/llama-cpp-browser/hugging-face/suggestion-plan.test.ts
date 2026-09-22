import { describe, expect, it } from 'vitest';
import { groupModelFiles } from './catalog';
import { modelSuggestions, preferredQuantizationHint, matchesMemoryHint, suggestedMemoryFilters, moreGgufModelsUrl } from './model-suggestions';
import { resolveSuggestionPlan, findLocalSuggestedModel, SuggestionPlanError } from './suggestion-plan';
import { artifactRole } from './artifact-role';
import { quantizationName, quantizationChoices } from './presentation';
import { variantLabel } from './model-variants';
import { fileDownloadUrl, formatDownloadBytes, selectionKey } from './download-plan';
const quantization = preferredQuantizationHint({ suggestion: modelSuggestions.find(entry => entry.id === 'muse-glimmer-30b')! });
const revision = 'a'.repeat(40);
const main = 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf';
const projector = 'mmproj-Muse-Glimmer-30B-Q4_K_M.gguf';
function catalog({ paths }: { paths: string[] }) {
  return { repository: quantization.repository, revision, ...groupModelFiles({ files: paths.map(path => ({ path, size: 128 })) }) };
}
describe('bundled suggestions and exact download plans', () => {
  it('keeps the agreed developer order, small models and only the requested memory chips', () => {
    expect(modelSuggestions.map(entry => entry.developer)).toEqual(['Google', 'Google', 'Google', 'OpenAI', 'Qwen', 'Qwen', 'Qwen', 'Liquid AI', 'Liquid AI', 'Meta', 'Hugging Face']);
    expect(modelSuggestions.map(entry => entry.id)).toContain('lfm-2-5-230m');
    expect(modelSuggestions.at(-1)?.id).toBe('smollm2-135m');
    expect(new Set(modelSuggestions.map(entry => entry.id)).size).toBe(modelSuggestions.length);
    expect(suggestedMemoryFilters).toEqual(['all', 8, 16, 32]);
    expect(moreGgufModelsUrl).toBe('https://huggingface.co/models?library=gguf');
    expect(matchesMemoryHint({ quantization, memory: 16, multimodal: 'off' })).toBe(false);
    expect(matchesMemoryHint({ quantization, memory: 32, multimodal: 'off' })).toBe(true);
    expect(matchesMemoryHint({ quantization, memory: 'all', multimodal: 'on' })).toBe(true);
  });
  it('leads with complete quantization tokens while preserving stored variant names', () => {
    expect(quantizationName({ path: main })).toBe('Q4_K_M');
    expect(quantizationName({ path: 'Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf' })).toBe('Q4_K_XL');
    expect(quantizationName({ path: 'model-Q4_K_MISH.gguf' })).toBe('Q4_K_MISH');
    expect(quantizationName({ path: 'model-Q4_K_M-Q8_0.gguf' })).toBeUndefined();
    const data = catalog({ paths: [main, 'dflash-Muse-Glimmer-30B-Q4_K_M.gguf'] });
    expect(quantizationChoices({ repository: data.repository, models: data.models })[0]?.label).toBe('Q4_K_M · KQuant-17GB');
    expect(variantLabel({ repository: quantization.repository, path: main })).toBe('KQuant-17GB-Q4_K_M');
  });
  it('excludes auxiliary GGUFs and opt-in projectors without trusting size hints', () => {
    const data = catalog({ paths: [main, projector, 'dflash-Muse-Glimmer-30B-Q4_K_M.gguf', 'mtp-Q4_K_M.gguf', 'eagle3-Q4_K_M.gguf'] });
    const changedHints = { ...quantization, approximateModelBytes: 1, approximateMultimodalBytes: 2 };
    expect(resolveSuggestionPlan({ quantization: changedHints, catalog: data, multimodal: 'off' })).toEqual({ repository: quantization.repository, revision, files: [{ path: main, size: 128 }] });
    expect(resolveSuggestionPlan({ quantization: changedHints, catalog: data, multimodal: 'on' }).files.map(file => file.path)).toEqual([main, projector]);
    expect(artifactRole({ path: 'draft/model-Q4_K_M.gguf' })).toBe('auxiliary');
    expect(artifactRole({ path: 'Crafted-Q4_K_M.gguf' })).toBe('model');
  });
  it('includes complete split parts but refuses incomplete splits, ambiguity or a different scheme', () => {
    const parts = ['Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00002.gguf'];
    expect(resolveSuggestionPlan({ quantization, catalog: catalog({ paths: parts }), multimodal: 'off' }).files.map(file => file.path)).toEqual(parts);
    for (const paths of [[parts[0]!], ['Model-Q4_K_XL.gguf'], [main, 'other-Q4_K_M.gguf']]) {
      expect(() => resolveSuggestionPlan({ quantization, catalog: catalog({ paths }), multimodal: 'off' })).toThrow(SuggestionPlanError);
    }
    expect(() => resolveSuggestionPlan({ quantization, catalog: catalog({ paths: [main] }), multimodal: 'on' })).toThrow(SuggestionPlanError);
    expect(() => resolveSuggestionPlan({ quantization, catalog: catalog({ paths: [main, 'mmproj-one-F16.gguf', 'mmproj-two-Q8_0.gguf'] }), multimodal: 'on' })).toThrow(SuggestionPlanError);
  });
  it('matches local repository identity and the exact main quantization, not approximate bytes or a filename coincidence', () => {
    const local = { id: `hf.co/${quantization.repository}:${encodeURIComponent(main)}`, name: 'already installed', size: 128, importedAt: 1 };
    expect(findLocalSuggestedModel({ quantization, models: [local] })).toEqual(local);
    expect(findLocalSuggestedModel({ quantization, models: [{ ...local, id: `user/${main}` }] })).toBeUndefined();
    for (const path of ['model-Q8_0.gguf', 'model-Q4_K_XL.gguf', 'dflash-Q4_K_M.gguf']) {
      expect(findLocalSuggestedModel({ quantization, models: [{ ...local, id: `hf.co/${quantization.repository}:${encodeURIComponent(path)}` }] })).toBeUndefined();
    }
    expect(findLocalSuggestedModel({ quantization, models: [local, { ...local, id: `hf.co/${quantization.repository}:other-Q4_K_M.gguf` }] })).toBeUndefined();
  });
  it('pins normal file-save links, encodes nested filenames and does not confuse decimal bytes with GiB', () => {
    const file = { path: 'nested/model name-Q4_K_M.gguf', size: 128 };
    expect(fileDownloadUrl({ repository: quantization.repository, revision, file })).toBe(`https://huggingface.co/${quantization.repository}/resolve/${revision}/nested/model%20name-Q4_K_M.gguf?download=true`);
    expect(() => fileDownloadUrl({ repository: quantization.repository, revision: 'main', file })).toThrow();
    expect(() => fileDownloadUrl({ repository: quantization.repository, revision, file: { ...file, path: '../bad.gguf' } })).toThrow();
    expect(formatDownloadBytes({ bytes: 16_800_000_000 })).toBe('15.65 GiB');
    const plan = resolveSuggestionPlan({ quantization, catalog: catalog({ paths: [main, projector] }), multimodal: 'on' });
    expect(selectionKey({ selection: plan })).toBe(selectionKey({ selection: { ...plan, files: [...plan.files].reverse() } }));
    expect(selectionKey({ selection: plan })).not.toBe(selectionKey({ selection: { ...plan, revision: 'b'.repeat(40) } }));
  });
});
