import { describe, expect, it, vi } from 'vitest';
import { createDownloadedModelWorkerFetch } from './offline-worker-fetch';

describe('createDownloadedModelWorkerFetch', () => {
  it('allows only the selected same-origin ONNX Runtime assets', async () => {
    const originalFetch = vi.fn(async () => new Response('runtime'));
    const fetch = createDownloadedModelWorkerFetch({
      originalFetch,
      workerLocationUrl: 'https://naidan.example/app/assets/worker.js',
      environment: 'development',
      userAgent: 'Chrome',
      vendor: 'Google Inc.',
    });

    await expect(fetch(
      'https://naidan.example/transformers/ort-wasm-simd-threaded.asyncify.mjs',
    )).resolves.toBeInstanceOf(Response);
    await expect(fetch(
      'https://naidan.example/transformers/ort-wasm-simd-threaded.asyncify.wasm',
    )).resolves.toBeInstanceOf(Response);
    expect(originalFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'https://huggingface.co/org/model/resolve/main/config.json',
    'https://cdn-lfs.huggingface.co/model.onnx',
    'https://naidan.example/api/model-proxy',
    'https://naidan.example/models/user/model/config.json',
    'https://naidan.example/transformers/unlisted.wasm',
  ])('fails closed for non-runtime request %s', async url => {
    const originalFetch = vi.fn();
    const fetch = createDownloadedModelWorkerFetch({
      originalFetch,
      workerLocationUrl: 'https://naidan.example/app/assets/worker.js',
      environment: 'development',
      userAgent: 'Chrome',
      vendor: 'Google Inc.',
    });

    await expect(fetch(url)).rejects.toThrow('blocked non-runtime network request');
    expect(originalFetch).not.toHaveBeenCalled();
  });
});
