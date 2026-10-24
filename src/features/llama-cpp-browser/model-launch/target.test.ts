import { describe, it, expect } from 'vitest';
import { modelLaunchTargetSchema } from '@/01-models/llama-cpp-browser-model-launch';
import { confirmModelLaunchConfiguration, modelLaunchChoices, resolveModelLaunchConfiguration, resolveModelLaunchTarget, targetForChoice, readLaunchCatalog, rememberLaunchCatalog, TEST_ONLY } from './target';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';

function catalog({ paths }: { paths: string[] }): RepositoryCatalog {
  return { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: paths.map(path => ({ label: path, files: [{ path, size: 256 }], size: 256 })) };
}

describe('model launch resolution', () => {
  it('asks for an actual main selection instead of choosing the first model for an unspecified variant', () => {
    const input = catalog({ paths: ['Model-Q4_K_M.gguf', 'Model-Q8_0.gguf'] });
    const result = resolveModelLaunchConfiguration({ input: input.repository, requestedVariant: undefined, catalog: input, multimodal: 'auto' });
    expect(result).toMatchObject({ status: 'needs-selection', selectedMainPath: undefined, companionRequirement: 'none' });
  });

  it('resolves the exact file selected by the metadata picker', () => {
    const input = catalog({ paths: ['Model-Q4_K_M.gguf', 'alternate/Model-UD-Q4_K_M.gguf'] });
    const result = resolveModelLaunchConfiguration({ input: input.repository, requestedVariant: 'alternate/Model-UD-Q4_K_M.gguf', catalog: input, multimodal: 'auto' });
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') {
      throw new Error('Expected the exact selected model');
    }
    expect(result.target.mainFilePath).toBe('alternate/Model-UD-Q4_K_M.gguf');
  });

  it('resolves the selected split main and exact companion from one pinned catalog', () => {
    const input = catalog({ paths: [] });
    const files = ['Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00002.gguf'].map(path => ({ path, size: 256 }));
    input.models = [{ label: 'Q4_K_M', size: 512, files }];
    input.projectors = ['first-mmproj.gguf', 'second-mmproj.gguf'].map(path => ({ path, size: 256 }));
    expect(resolveModelLaunchConfiguration({ input: input.repository, requestedVariant: 'Q4_K_M', catalog: input, multimodal: 'auto' }).status).toBe('needs-selection');
    const target = confirmModelLaunchConfiguration({ catalog: input, mainFilePath: files[0]!.path, companionFilePath: 'second-mmproj.gguf', multimodal: 'auto' });
    expect(target.selection).toEqual({ repository: input.repository, revision: input.revision, files: [...files, input.projectors[1]] });
    expect(() => confirmModelLaunchConfiguration({ catalog: input, mainFilePath: files[0]!.path, companionFilePath: 'outside.gguf', multimodal: 'auto' })).toThrow('companion-required');
  });

  it('selects the ordinary Q4 model before Q8 and auxiliary weights', () => {
    const result = resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: catalog({ paths: ['Model-Q8_0.gguf', 'Model-Q4_K_M.gguf', 'mmproj-F16.gguf'] }) });
    expect(result.target.mainFilePath).toBe('Model-Q4_K_M.gguf');
    expect(result.requestedVariant).toBeUndefined();
    expect(result.target.modelId).toBe('hf.co/owner/Model-GGUF:Q4_K_M');
  });

  it('resolves an explicit quantization and retains the fixed-selection intent', () => {
    const result = resolveModelLaunchTarget({ input: 'hf.co/owner/Model-GGUF:Q8_0', catalog: catalog({ paths: ['Model-Q4_K_M.gguf', 'Model-Q8_0.gguf'] }) });
    expect(result.requestedVariant).toBe('Q8_0');
    expect(result.target.mainFilePath).toBe('Model-Q8_0.gguf');
  });

  it.each(['UD-IQ4_NL', 'UD-Q4_K_XL', 'AWQ-Q4_K_M', 'QAD-Q4_0', 'FutureMethod-q4_Custom', 'imatrix/UD-Q4_K_XL'])('retains the displayed variant and resolves its canonical selector: %s', variant => {
    const parts = variant.split('/');
    const stem = parts.pop()!;
    const path = [...parts, `Model-${stem}.gguf`].join('/');
    const input = catalog({ paths: ['Model-IQ4_NL.gguf', 'Model-Q4_K_M.gguf', path] });
    expect(modelLaunchChoices({ catalog: input }).find(choice => choice.primaryRelativePath === path)?.label).toBe(variant);
    const { target } = resolveModelLaunchTarget({ input: `owner/Model-GGUF:${variant}`, catalog: input });
    expect(target.mainFilePath).toBe(path);
    expect(target.selection.files).toEqual([{ path, size: 256 }]);
    expect(target.modelId).toBe(`hf.co/owner/Model-GGUF:${variant}`);
  });

  it.each([
    { variant: 'UD-IQ4_NL', previousLabel: 'IQ4_NL · UD' },
    { variant: 'UD-Q4_K_XL', previousLabel: 'Q4_K_XL · UD' },
    { variant: 'AWQ-Q4_K_M', previousLabel: 'Q4_K_M · AWQ' },
  ])('resolves previously displayed labels to the same exact files: $previousLabel', ({ variant, previousLabel }) => {
    const input = catalog({ paths: ['Model-IQ4_NL.gguf', 'Model-Q4_K_M.gguf', `Model-${variant}.gguf`] });
    const canonical = resolveModelLaunchTarget({ input: `owner/Model-GGUF:${variant}`, catalog: input });
    const previous = resolveModelLaunchTarget({ input: `owner/Model-GGUF:${previousLabel}`, catalog: input });
    expect(previous.target).toEqual(canonical.target);
  });

  it.each(['Q6_K', 'Q4_K_M'])('never substitutes an unavailable or ambiguous %s', variant => {
    expect(() => resolveModelLaunchTarget({ input: `owner/Model-GGUF:${variant}`, catalog: catalog({ paths: ['first-Q4_K_M.gguf', 'other-Q4_K_M.gguf'] }) })).toThrow('variant-unavailable');
  });

  it('rejects a default choice when distinct file groups have the same public modelId', () => {
    expect(() => resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: catalog({ paths: ['Model-Q4_K_M.gguf', 'Model_Q4_K_M.gguf'] }) })).toThrow('variant-unavailable');
  });

  it('does not guess between companion families', () => {
    const input = catalog({ paths: ['Model-Q4_K_M.gguf'] });
    input.projectors = ['first-mmproj-F16.gguf', 'other-mmproj-F16.gguf'].map(path => ({ path, size: 256 }));
    expect(() => targetForChoice({ catalog: input, path: 'Model-Q4_K_M.gguf' })).toThrow('companion-required');
  });

  it('uses the first shard in a split model as the same canonical local identity', () => {
    const input = catalog({ paths: [] });
    const files = ['Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00002.gguf'].map(path => ({ path, size: 256 }));
    input.models = [{ label: 'Model-Q4_K_M', files, size: 512 }];
    const { target } = resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: input });
    expect(target.selection.files).toHaveLength(2);
    expect(target.mainFilePath).toBe(files[0]!.path);
  });

  it('rejects malformed persisted targets without throwing from safeParse', () => {
    const { target } = resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: catalog({ paths: ['Model-Q4_K_M.gguf'] }) });
    expect(modelLaunchTargetSchema.safeParse({ ...target, modelId: 'user/other' }).success).toBe(false);
    expect(modelLaunchTargetSchema.safeParse({ ...target, mainFilePath: '../evil.gguf' }).success).toBe(false);
    expect(modelLaunchTargetSchema.safeParse({ ...target, selection: { ...target.selection, files: [{ path: '../evil.gguf', size: 256 }] }, mainFilePath: '../evil.gguf' }).success).toBe(false);
    expect(modelLaunchTargetSchema.safeParse({ ...target, selection: { ...target.selection, files: [{ path: 'weights.txt', size: 256 }] }, mainFilePath: 'weights.txt' }).success).toBe(false);
    expect(modelLaunchTargetSchema.safeParse({ ...target, selection: { ...target.selection, repository: '../invalid' } }).success).toBe(false);
  });

  it('has a memory-only catalog cache which does not fetch on a miss', () => {
    TEST_ONLY.reset();
    expect(readLaunchCatalog({ repository: 'owner/Model-GGUF' })).toBeUndefined();
    const value = catalog({ paths: ['Model-Q4_K_M.gguf'] });
    rememberLaunchCatalog({ catalog: value });
    expect(readLaunchCatalog({ repository: value.repository })).toBe(value);
    TEST_ONLY.reset();
    expect(readLaunchCatalog({ repository: value.repository })).toBeUndefined();
  });
});
