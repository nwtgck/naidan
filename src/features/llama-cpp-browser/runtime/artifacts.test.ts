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
    await expect(loadStandaloneWasm({ profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined })).resolves.toEqual(new Uint8Array([71]));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks the embedded SHA-256 rather than accepting same-length changed bytes', async () => {
    embedded.base64 = brotliCompressSync(new Uint8Array([72])).toString('base64');
    await expect(loadStandaloneWasm({ profile: 'webgpu-wasm64-jspi', assetBaseURL: undefined })).rejects.toThrow('integrity mismatch');
  });
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify'] as const)('rejects the non-embedded profile %s before decoding', async profile => {
    const digest = vi.spyOn(crypto.subtle, 'digest');
    await expect(loadStandaloneWasm({ profile, assetBaseURL: undefined })).rejects.toThrow('unavailable');
    expect(digest).not.toHaveBeenCalled();
  });
  it('does not let an external URL select another transport or bypass verification', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(loadStandaloneWasm({ profile: 'webgpu-wasm64-jspi', assetBaseURL: 'https://fixture.invalid/' })).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('hosted artifact transport', () => {
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi'] as const)('retains gzip for %s even without Brotli support', async profile => {
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
    await expect(loadHostedWasm({ profile, assetBaseURL: 'https://fixture.invalid/runtime/' })).resolves.toEqual(source);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([new URL(`${profile}/core.wasm.gz`, 'https://fixture.invalid/runtime/')]);
    expect(formats).toEqual(['gzip']);
  });
});
