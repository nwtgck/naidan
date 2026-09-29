import { describe, it, expect } from 'vitest';
import { modelLaunchTargetSchema } from '@/01-models/llama-cpp-browser-model-launch';
import { resolveModelLaunchTarget, targetForChoice, readLaunchCatalog, rememberLaunchCatalog, TEST_ONLY } from './target';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
function catalog({ paths }: { paths: string[] }): RepositoryCatalog {
  return { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), projectors: [], models: paths.map(path => ({ label: path, files: [{ path, size: 256 }], size: 256 })) };
}
describe('model launch resolution', () => {
  it('selects the ordinary Q4 model before Q8 and auxiliary weights', () => {
    const result = resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: catalog({ paths: ['Model-Q8_0.gguf', 'Model-Q4_K_M.gguf', 'mmproj-F16.gguf'] }) });
    expect(result.target.mainFilePath).toBe('Model-Q4_K_M.gguf');
    expect(result.requestedVariant).toBeUndefined();
    expect(result.target.modelId).toBe('hf.co/owner/Model-GGUF:Model-Q4_K_M.gguf');
  });
  it('resolves an explicit quantization and retains the fixed-selection intent', () => {
    const result = resolveModelLaunchTarget({ input: 'hf.co/owner/Model-GGUF:Q8_0', catalog: catalog({ paths: ['Model-Q4_K_M.gguf', 'Model-Q8_0.gguf'] }) });
    expect(result.requestedVariant).toBe('Q8_0'); expect(result.target.mainFilePath).toBe('Model-Q8_0.gguf');
  });
  it.each(['Q6_K','Q4_K_M'])('never substitutes an unavailable or ambiguous %s', variant => {
    expect(() => resolveModelLaunchTarget({ input: `owner/Model-GGUF:${variant}`, catalog: catalog({ paths: ['first-Q4_K_M.gguf','other-Q4_K_M.gguf'] }) })).toThrow('variant-unavailable');
  });
  it('does not guess between companion families', () => {
    const input = catalog({ paths: ['Model-Q4_K_M.gguf'] });
    input.projectors = ['first-mmproj-F16.gguf', 'other-mmproj-F16.gguf'].map(path => ({ path, size: 256 }));
    expect(() => targetForChoice({ catalog: input, path: 'Model-Q4_K_M.gguf' })).toThrow('companion-required');
  });
  it('uses the first shard in a split model as the same canonical local identity', () => {
    const input = catalog({ paths: [] });
    const files = ['Model-Q4_K_M-00001-of-00002.gguf','Model-Q4_K_M-00002-of-00002.gguf'].map(path => ({ path, size: 256 }));
    input.models = [{ label: 'Model-Q4_K_M', files, size: 512 }];
    const { target } = resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: input });
    expect(target.selection.files).toHaveLength(2); expect(target.mainFilePath).toBe(files[0]!.path);
  });
  it('rejects malformed persisted targets without throwing from safeParse', () => {
    const { target } = resolveModelLaunchTarget({ input: 'owner/Model-GGUF', catalog: catalog({ paths: ['Model-Q4_K_M.gguf'] }) });
    expect(modelLaunchTargetSchema.safeParse({ ...target, modelId: 'user/other' }).success).toBe(false);
    expect(modelLaunchTargetSchema.safeParse({ ...target, mainFilePath: '../evil.gguf' }).success).toBe(false);
    expect(modelLaunchTargetSchema.safeParse({ ...target, selection: { ...target.selection, files: [{ path: '../evil.gguf', size: 256 }] }, mainFilePath: '../evil.gguf' }).success).toBe(false);
  });
  it('has a memory-only catalog cache which does not fetch on a miss', () => {
    TEST_ONLY.reset(); expect(readLaunchCatalog({ repository: 'owner/Model-GGUF' })).toBeUndefined();
    const value = catalog({ paths: ['Model-Q4_K_M.gguf'] }); rememberLaunchCatalog({ catalog: value });
    expect(readLaunchCatalog({ repository: value.repository })).toBe(value);
    TEST_ONLY.reset(); expect(readLaunchCatalog({ repository: value.repository })).toBeUndefined();
  });
});
