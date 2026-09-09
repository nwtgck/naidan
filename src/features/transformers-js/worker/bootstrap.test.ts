import { afterEach, expect, it, vi } from 'vitest';
import { PRODUCTION_WORKER_READY } from './production-worker-startup';

afterEach(() => {
  vi.doUnmock('./entry');
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('installs fail-closed fetch before entry evaluation and emits ready only after entry resolves', async () => {
  const entryEntered = Promise.withResolvers<void>();
  const entryFinished = Promise.withResolvers<void>();
  const readySent = Promise.withResolvers<void>();
  const initialized = Promise.withResolvers<void>();
  const requestId = '11111111-1111-4111-8111-111111111111';
  const originalFetch = vi.fn(() => {
    throw new Error('Unexpected unrestricted fetch');
  });
  const postMessage = vi.fn(message => {
    expect(message).toEqual({ ...PRODUCTION_WORKER_READY, requestId });
    readySent.resolve();
  });
  vi.stubGlobal('self', {
    fetch: originalFetch,
    location: { href: 'https://naidan.invalid/src/features/transformers-js/worker/bootstrap.ts' },
    postMessage,
  });
  vi.stubGlobal('navigator', { userAgent: 'Chrome', vendor: 'Google' });
  vi.doMock('./entry', async () => {
    expect(self.fetch).not.toBe(originalFetch);
    await expect(self.fetch('https://huggingface.co/public/model/resolve/main/config.json')).rejects.toThrow('blocked non-runtime');
    entryEntered.resolve();
    await entryFinished.promise;
    return { initializeProductionWorkerRuntime: async () => {
      await initialized.promise;
      return { requestId };
    } };
  });
  await import('./bootstrap');
  await entryEntered.promise;
  expect(postMessage).not.toHaveBeenCalled();
  expect(originalFetch).not.toHaveBeenCalled();
  entryFinished.resolve();
  expect(postMessage).not.toHaveBeenCalled();
  initialized.resolve();
  await readySent.promise;
  expect(postMessage).toHaveBeenCalledOnce();
});
