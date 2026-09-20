import { describe, expect, it, vi } from 'vitest';
import { cancelDownload, downloadRepository } from './download-standalone';

describe('standalone browser model downloads', () => {
  it('rejects downloads as unavailable without reporting progress', async () => {
    const onProgress = vi.fn();
    await expect(downloadRepository({
      selection: { repository: 'example/model', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 24 }] },
      signal: new AbortController().signal,
      onProgress,
    })).rejects.toThrow('llama.cpp browser: unavailable');
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects deletion as unavailable', async () => {
    await expect(cancelDownload({
      repository: 'example/model',
      plan: { id: 'example-model', files: [] },
    })).rejects.toThrow('llama.cpp browser: unavailable');
  });
});
