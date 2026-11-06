import { describe, expect, it } from 'vitest';
import { splitModelName } from './model-name';

describe('generic model name display', () => {
  it('shares the selector convention without inspecting or renaming a model', () => {
    expect(splitModelName({ name: 'host/models-for-browser-2/pfnet/plamo-3-translate-0.8b-GGUF:Q4_K_M' })).toEqual({ prefix: 'host/models-for-browser-2/pfnet/', suffix: 'plamo-3-translate-0.8b-GGUF:Q4_K_M' });
    expect(splitModelName({ name: 'custom.gguf' })).toEqual({ prefix: '', suffix: 'custom.gguf' });
    expect(splitModelName({ name: undefined })).toEqual({ prefix: '', suffix: undefined });
  });
});
