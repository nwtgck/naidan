import { describe, expect, it, vi } from 'vitest';
import { requireDownloadedModelConfig } from './required-downloaded-config';

const identity = {
  modelId: 'org/model', revision: undefined, workerLocationUrl: 'https://naidan.invalid/worker.js',
};

describe('required local configuration admission', () => {
  it('classifies only a cache miss as incomplete in the pinned legacy namespace', async () => {
    const match = vi.fn(async () => undefined);
    await expect(requireDownloadedModelConfig({ ...identity, modelCache: { match } })).rejects.toMatchObject({
      name: 'MissingDownloadedModelArtifact',
    });
    expect(match.mock.calls).toEqual([['https://huggingface.co/org/model/resolve/main/config.json']]);
  });

  it('preserves a cache I/O rejection instead of classifying it as missing', async () => {
    const failure = new DOMException('Read failed', 'NotReadableError');
    const match = vi.fn(async () => {
      throw failure;
    });
    await expect(requireDownloadedModelConfig({ ...identity, modelCache: { match } })).rejects.toBe(failure);
    expect(match).toHaveBeenCalledTimes(1);
  });

  it('cancels a present response without reading or interpreting its bytes', async () => {
    const response = new Response('{ malformed');
    const cancel = vi.spyOn(response.body!, 'cancel');
    const json = vi.spyOn(response, 'json');
    const match = vi.fn(async () => response);
    await expect(requireDownloadedModelConfig({
      ...identity, revision: 'fixed', modelCache: { match },
    })).resolves.toBeUndefined();
    expect(match.mock.calls).toEqual([['https://huggingface.co/org/model/resolve/fixed/config.json']]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it('preserves response cancellation errors instead of classifying them as missing', async () => {
    const response = new Response('{}');
    const failure = new Error('Cannot close local stream');
    vi.spyOn(response.body!, 'cancel').mockRejectedValue(failure);
    const match = vi.fn(async () => response);
    await expect(requireDownloadedModelConfig({ ...identity, modelCache: { match } })).rejects.toBe(failure);
  });
});
