// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadQ8DiagnosticSchema } from './q8-diagnostic-assets';

const profile = 'webgpu-wasm64-jspi-gpu-profile' as const;
const assetBaseURL = 'https://fixture.invalid/app/llama-cpp-browser-runtime/profiles/';
const bytes = new TextEncoder().encode('{"fixture":"schema bytes"}');
const asset = { relativePath: `${profile}/q8-diagnostic-v1.schema.json`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

describe('explicit Q8 diagnostic schema download', () => {
  it('does not fetch for an older package or an ordinary runtime', async () => {
    using fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(loadQ8DiagnosticSchema({ profile, assetBaseURL, asset: undefined, signal: undefined })).resolves.toBeUndefined();
    await expect(loadQ8DiagnosticSchema({ profile: 'webgpu-wasm64-jspi', assetBaseURL, asset, signal: undefined })).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks all streamed bytes against the asset hash using the existing profiles base', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 3));
        controller.enqueue(bytes.slice(3));
        controller.close();
      },
    }));
    using fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const controller = new AbortController();
    const result = await loadQ8DiagnosticSchema({ profile, assetBaseURL, asset, signal: controller.signal });
    expect(result).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(new URL(asset.relativePath, assetBaseURL), { signal: controller.signal });
    expect(response.body?.locked).toBe(false);
  });

  it.each([
    { metadata: { ...asset, relativePath: '../core.wasm' }, base: assetBaseURL },
    { metadata: { ...asset, bytes: 256 * 1024 + 1 }, base: assetBaseURL },
    { metadata: { ...asset, bytes: 0 }, base: assetBaseURL },
    { metadata: { ...asset, sha256: 'not an asset digest' }, base: assetBaseURL },
    { metadata: asset, base: undefined },
  ])('rejects invalid asset metadata before starting a download: $metadata', async ({ metadata, base }) => {
    using fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(loadQ8DiagnosticSchema({ profile, assetBaseURL: base, asset: metadata, signal: undefined })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels an oversized body without retaining extra chunks', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.length + 1));
      },
      cancel,
    }));
    using _fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(loadQ8DiagnosticSchema({ profile, assetBaseURL, asset, signal: undefined })).rejects.toThrow('exceeds its published size');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(['short', 'same-size-corruption', 'http-failure'] as const)('rejects an unusable response: %s', async failure => {
    let response: Response;
    switch (failure) {
    case 'short': response = new Response(bytes.slice(1));
      break;
    case 'same-size-corruption': response = new Response(new Uint8Array(bytes.length));
      break;
    case 'http-failure': response = new Response(undefined, { status: 404 });
      break;
    default: {
      const exhaustive: never = failure;
      throw new Error(String(exhaustive));
    }
    }
    using _fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(loadQ8DiagnosticSchema({ profile, assetBaseURL, asset, signal: undefined })).rejects.toThrow();
  });

  it('honors cancellation before loading without invoking fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    using fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(loadQ8DiagnosticSchema({ profile, assetBaseURL, asset, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
