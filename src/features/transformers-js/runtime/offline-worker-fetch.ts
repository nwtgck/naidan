import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';

function requestUrl({ input }: { input: RequestInfo | URL }): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Creates the only network capability installed in a downloaded-model Worker.
 *
 * The allowlist is derived from the build-owned runtime asset selection rather
 * than from request origin alone: allowing arbitrary same-origin URLs would let
 * an SPA route, proxy, or future endpoint accidentally become a model-download
 * path. The unrestricted browser fetch remains captured only inside this
 * closure and is never passed to Transformers.js or exported by the Worker.
 */
export function createDownloadedModelWorkerFetch({
  originalFetch,
  workerLocationUrl,
  environment,
  userAgent,
  vendor,
}: {
  originalFetch: typeof fetch;
  workerLocationUrl: string;
  environment: 'development' | 'production';
  userAgent: string | undefined;
  vendor: string | undefined;
}): typeof fetch {
  const assets = resolveHostedTransformersRuntimeAssetUrls({
    workerLocationUrl,
    environment,
    userAgent,
    vendor,
  });
  const allowedUrls = new Set([
    assets.mjsUrl,
    assets.wasmUrl,
    assets.physicalWasmUrl,
  ]);

  return async (input, init) => {
    const url = new URL(requestUrl({ input }), workerLocationUrl);
    if (!allowedUrls.has(url.href)) {
      throw new Error(`Downloaded-model Worker blocked non-runtime network request: ${url.href}`);
    }
    if (url.origin !== new URL(workerLocationUrl).origin) {
      throw new Error(`Downloaded-model Worker blocked cross-origin runtime request: ${url.origin}`);
    }
    return await originalFetch(url.href, init);
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
