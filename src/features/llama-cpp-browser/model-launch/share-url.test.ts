import { describe, expect, it } from 'vitest';
import { groupModelFiles, type RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { MODEL_LAUNCH_QUERY } from './entry-state';
import { modelLaunchShareUrl } from './share-url';
import { resolveModelLaunchTarget } from './target';

function catalog({ paths }: { paths: string[] }): RepositoryCatalog {
  return { repository: 'owner/Model-GGUF', revision: 'a'.repeat(40), ...groupModelFiles({ files: paths.map(path => ({ path, size: 128 })) }) };
}

describe('model launch share URLs', () => {
  it.each([
    { paths: ['Model-Q4_K_M.gguf'], variant: 'Q4_K_M' },
    { paths: ['UD-IQ4_NL/Model-UD-IQ4_NL-00001-of-00002.gguf', 'UD-IQ4_NL/Model-UD-IQ4_NL-00002-of-00002.gguf'], variant: 'UD-IQ4_NL' },
    { paths: ['imatrix/Model-Q4_K_M.gguf'], variant: 'imatrix/Q4_K_M' },
    { paths: ['特殊/Model-50%?#-Q4_K_M.gguf'], variant: '特殊/50%?#-Q4_K_M' },
  ])('round-trips the complete public variant $variant to the same model files', ({ paths, variant }) => {
    const source = catalog({ paths });
    const result = modelLaunchShareUrl({ baseUrl: 'https://naidan.example/app/?old=query#/settings?other=state', catalog: source, mainFilePath: paths[0]! });
    expect(result).toBeDefined();
    const url = new URL(result!);
    const query = new URLSearchParams(url.hash.slice('#/?'.length));
    const input = query.get(MODEL_LAUNCH_QUERY)!;
    expect(url.origin + url.pathname).toBe('https://naidan.example/app/');
    expect(url.search).toBe('');
    expect([...query.keys()]).toEqual([MODEL_LAUNCH_QUERY]);
    expect(input).toBe(`hf.co/owner/Model-GGUF:${encodeURIComponent(variant)}`);
    const resolved = resolveModelLaunchTarget({ input, catalog: source });
    expect(resolved.requestedVariant).toBe(variant);
    expect(resolved.target.mainFilePath).toBe(paths[0]);
    expect(resolved.target.selection.files.map(file => file.path)).toEqual(paths);
    expect(input).not.toContain('00001-of-00002');
  });

  it.each([
    { baseUrl: 'file:///home/user/Naidan%20App/naidan.html?old=query#/chat/old', expected: 'file:///home/user/Naidan%20App/naidan.html' },
    { baseUrl: 'https://naidan.example/sub/app.html?old=query#/audio-generation', expected: 'https://naidan.example/sub/app.html' },
  ])('preserves the installation location $expected', ({ baseUrl, expected }) => {
    const result = modelLaunchShareUrl({ baseUrl, catalog: catalog({ paths: ['Model-Q4_K_M.gguf'] }), mainFilePath: 'Model-Q4_K_M.gguf' });
    expect(result?.split('#')[0]).toBe(expected);
    expect(result).toContain('#/?llama-cpp-browser-model=');
    expect(result).not.toContain('old');
  });

  it('keeps ordinary and UD versions distinct without serializing download settings', () => {
    const source = catalog({ paths: ['Model-IQ4_NL.gguf', 'Model-UD-IQ4_NL.gguf', 'mmproj-F16.gguf'] });
    const ordinary = modelLaunchShareUrl({ baseUrl: 'https://naidan.example/', catalog: source, mainFilePath: 'Model-IQ4_NL.gguf' });
    const ud = modelLaunchShareUrl({ baseUrl: 'https://naidan.example/', catalog: source, mainFilePath: 'Model-UD-IQ4_NL.gguf' });
    expect(ordinary).toBeDefined();
    expect(ud).toBeDefined();
    expect(ordinary).not.toBe(ud);
    expect(decodeURIComponent(ud!)).toContain(':UD-IQ4_NL');
    expect(ud).not.toContain(source.revision);
    expect(ud).not.toContain('mmproj');
  });

  it.each([
    { paths: ['Model-Q4_K_M.gguf', 'Model_Q4_K_M.gguf'], mainFilePath: 'Model-Q4_K_M.gguf' },
    { paths: ['Model-UD-IQ4_NL.gguf', 'Model-IQ4_NL · UD.gguf'], mainFilePath: 'Model-IQ4_NL · UD.gguf' },
    { paths: ['Model-Q4_K_M.gguf', 'mtp/Model-Q4_K_M.gguf'], mainFilePath: 'mtp/Model-Q4_K_M.gguf' },
    { paths: ['Model-Q4_K_M.gguf', 'first/mmproj-F16.gguf', 'other/mmproj-F16.gguf'], mainFilePath: 'Model-Q4_K_M.gguf' },
    { paths: ['Model-Q4_K_M.gguf'], mainFilePath: 'missing-Q8_0.gguf' },
    { paths: ['Model-Q4_K_M.gguf'], mainFilePath: 'Model_Q4_K_M.gguf' },
  ])('omits selectors that cannot resolve the selected main file: $mainFilePath', ({ paths, mainFilePath }) => {
    expect(modelLaunchShareUrl({ baseUrl: 'https://naidan.example/', catalog: catalog({ paths }), mainFilePath })).toBeUndefined();
  });

  it('does not leak a resolver validation error for model IDs beyond its existing length limit', () => {
    const path = `${'a'.repeat(180)}/${'b'.repeat(180)}/${'c'.repeat(180)}/Model-Q4_K_M.gguf`;
    const source = catalog({ paths: [path] });
    expect(source.models).toHaveLength(1);
    expect(modelLaunchShareUrl({ baseUrl: 'https://naidan.example/', catalog: source, mainFilePath: path })).toBeUndefined();
  });

  it('omits unencodable names without leaking URI errors into rendering', () => {
    const path = `Model-${String.fromCharCode(0xD800)}-Q4_K_M.gguf`;
    const source = catalog({ paths: [path] });
    expect(source.models).toHaveLength(1);
    expect(modelLaunchShareUrl({ baseUrl: 'https://naidan.example/', catalog: source, mainFilePath: path })).toBeUndefined();
  });
});
