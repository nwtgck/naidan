// @vitest-environment node
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWasmBinary as loadHostedWasm } from './artifacts';
import { loadWasmBinary as loadStandaloneWasm } from './artifacts-standalone';
import { installBrotliDecoderForTest } from '@/features/file-protocol-standalone/embedded-binary.test-support';

const embedded = vi.hoisted(() => ({
  base64: 'CwCARwM=', byteLength: 1,
  sha256: '333e0a1e27815d0ceee55c473fe3dc93d56c63e3bee2b3b4aee8eed6d70191a3',
}));
vi.mock('virtual:file-protocol-standalone/binary/llama-cpp-browser', () => embedded);
vi.mock('virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi', () => ({
  ...embedded, base64: 'iwCASE0D', byteLength: 2,
  sha256: '58462b5910a20aab56603dcc673dc581942c66f14846580beaaf4aaa5d6bde47',
}));
const nativeDecompressionStream = DecompressionStream;
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('standalone artifact transport', () => {
  beforeEach(() => {
    embedded.base64 = 'CwCARwM=';
    installBrotliDecoderForTest();
  });
  it('decodes and verifies the embedded Brotli payload without an asset URL', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(loadStandaloneWasm({ signal: undefined, profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined })).resolves.toEqual(new Uint8Array([71]));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('routes the wasm32 artifact to its own embedded payload', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(loadStandaloneWasm({ signal: undefined, profile: 'webgpu-wasm32-jspi', assetBaseURL: undefined })).resolves.toEqual(new Uint8Array([72, 77]));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks the embedded SHA-256 rather than accepting same-length changed bytes', async () => {
    embedded.base64 = brotliCompressSync(new Uint8Array([72])).toString('base64');
    await expect(loadStandaloneWasm({ signal: undefined, profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined })).rejects.toThrow('integrity mismatch');
  });
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify'] as const)('rejects the non-embedded profile %s before decoding', async profile => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(loadStandaloneWasm({ signal: undefined, profile, assetBaseURL: undefined })).rejects.toThrow('unavailable');
    expect(digest).not.toHaveBeenCalled();
  });
  it('does not let an external URL select another transport or bypass verification', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(loadStandaloneWasm({ signal: undefined, profile: 'webgpu-wasm64-jspi', assetBaseURL: 'https://fixture.invalid/' })).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('hosted artifact transport', () => {
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi'] as const)('retains gzip for %s even without Brotli support', async profile => {
    const source = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const fetcher = vi.fn(async () => new Response(gzipSync(source)));
    vi.stubGlobal('fetch', fetcher);
    const formats: string[] = [];
    vi.stubGlobal('DecompressionStream', class {
      constructor(format: string) {
        formats.push(format);
        if (format !== 'gzip') throw new TypeError('Only gzip is supported');
        return new nativeDecompressionStream(format);
      }
    });
    // Hosted does not select a compression format by browser name.
    vi.stubGlobal('navigator', { get userAgent() {
      throw new Error('No browser sniffing');
    } });
    await expect(loadHostedWasm({ signal: undefined, profile, assetBaseURL: 'https://fixture.invalid/runtime/' })).resolves.toEqual(source);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([new URL(`${profile}/core.wasm.gz`, 'https://fixture.invalid/runtime/'), { signal: undefined }]);
    expect(formats).toEqual(['gzip']);
  });
});


describe('cancelled artifact acquisition', () => {
  it('passes cancellation to the hosted byte download', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: URL, options: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher);
    const pending = loadHostedWasm({ profile: 'cpu-wasm32', assetBaseURL: 'https://fixture.invalid/runtime/', signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]?.[1].signal).toBe(controller.signal);
    controller.abort(); await rejected;
  });
  it('rejects pre-aborted hosted and standalone reads without fetching or decoding', async () => {
    const fetcher = vi.fn(); const digest = vi.spyOn(crypto.subtle, 'digest');
    vi.stubGlobal('fetch', fetcher);
    for (const load of [loadHostedWasm, loadStandaloneWasm]) {
      await expect(load({ profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(digest).not.toHaveBeenCalled();
  });
});
