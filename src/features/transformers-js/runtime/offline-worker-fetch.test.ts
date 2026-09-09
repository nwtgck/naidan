// @vitest-environment node
import { createServer, type RequestListener } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createDownloadedModelWorkerFetch } from './offline-worker-fetch';

async function loopbackServer({ listener }: { listener: RequestListener }) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected loopback TCP address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

const runtimePath = '/transformers/ort-wasm-simd-threaded.asyncify.mjs';

describe('createDownloadedModelWorkerFetch', () => {
  it('does not send a request to a forbidden same-origin redirect target', async () => {
    const received: string[] = [];
    const server = await loopbackServer({ listener: (request, response) => {
      received.push(request.url ?? '');
      if (request.url === runtimePath) {
        response.writeHead(302, { Location: '/forbidden-model' });
      }
      response.end('fixture');
    } });
    try {
      const guarded = createDownloadedModelWorkerFetch({
        originalFetch: globalThis.fetch, workerLocationUrl: `${server.origin}/worker.js`,
        environment: 'development', userAgent: 'Chrome', vendor: 'Google Inc.',
      });
      const outcome = await guarded(`${server.origin}${runtimePath}`).then(
        async response => {
          await response.text(); return undefined;
        },
        (error: unknown) => error,
      );
      expect(received).toEqual([runtimePath]);
      expect(outcome).toBeInstanceOf(TypeError);
    } finally {
      await server.close();
    }
  });

  it('does not follow a cross-origin loopback redirect even when the caller requests follow', async () => {
    const forbiddenRequests: string[] = [];
    const forbidden = await loopbackServer({ listener: (request, response) => {
      forbiddenRequests.push(request.url ?? '');
      response.end('forbidden');
    } });
    const received: string[] = [];
    const allowed = await loopbackServer({ listener: (request, response) => {
      received.push(request.url ?? '');
      response.writeHead(302, { Location: `${forbidden.origin}/model.onnx` });
      response.end();
    } });
    try {
      const guarded = createDownloadedModelWorkerFetch({
        originalFetch: globalThis.fetch, workerLocationUrl: `${allowed.origin}/worker.js`,
        environment: 'development', userAgent: 'Chrome', vendor: 'Google Inc.',
      });
      const outcome = await guarded(`${allowed.origin}${runtimePath}`, { redirect: 'follow' }).then(
        async response => {
          await response.text(); return undefined;
        },
        (error: unknown) => error,
      );
      expect(received).toEqual([runtimePath]);
      expect(forbiddenRequests).toEqual([]);
      expect(outcome).toBeInstanceOf(TypeError);
    } finally {
      await allowed.close();
      await forbidden.close();
    }
  });

  it('does not dispatch an already aborted runtime Request', async () => {
    const received: string[] = [];
    const server = await loopbackServer({ listener: (request, response) => {
      received.push(request.url ?? '');
      response.end('runtime');
    } });
    try {
      const guarded = createDownloadedModelWorkerFetch({
        originalFetch: globalThis.fetch, workerLocationUrl: `${server.origin}/worker.js`,
        environment: 'development', userAgent: 'Chrome', vendor: 'Google Inc.',
      });
      const controller = new AbortController();
      const reason = new Error('fixture request cancelled before dispatch');
      controller.abort(reason);
      const request = new Request(`${server.origin}${runtimePath}`, { signal: controller.signal });
      await expect(guarded(request)).rejects.toBe(reason);
      expect(received).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('retains Request attributes and init overrides while enforcing redirect rejection', async () => {
    const originalFetch = vi.fn<typeof fetch>(async () => new Response('runtime'));
    const guarded = createDownloadedModelWorkerFetch({
      originalFetch, workerLocationUrl: 'https://naidan.example/worker.js',
      environment: 'development', userAgent: 'Chrome', vendor: 'Google Inc.',
    });
    const controller = new AbortController();
    const request = new Request(`https://naidan.example${runtimePath}`, {
      method: 'GET', headers: { 'X-Fixture': 'request' }, credentials: 'omit',
      cache: 'no-store', signal: controller.signal, redirect: 'follow',
    });
    await guarded(request, { headers: { 'X-Fixture': 'init' }, redirect: 'follow' });
    const [input, init] = originalFetch.mock.calls[0]!;
    const effective = new Request(input, init);
    expect(effective.method).toBe('GET');
    expect(effective.headers.get('X-Fixture')).toBe('init');
    expect(effective.credentials).toBe('omit');
    expect(effective.cache).toBe('no-store');
    expect(effective.redirect).toBe('error');
    const reason = new Error('fixture request aborted');
    controller.abort(reason);
    expect(effective.signal.aborted).toBe(true);
    expect(effective.signal.reason).toBe(reason);
  });

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
