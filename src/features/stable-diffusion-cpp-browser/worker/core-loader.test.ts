// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { loadCoreFactory } from './core-loader';

afterEach(() => vi.unstubAllGlobals());

function prepare({ bytes, status }: { bytes: Uint8Array, status: number }): void {
  vi.stubGlobal('self', { location: { origin: 'https://naidan.invalid' } });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(gzipSync(bytes)), { status })));
}
it('rejects a cross-origin runtime base before making any request', async () => {
  prepare({ bytes: new Uint8Array(8), status: 200 });
  await expect(loadCoreFactory({ artifact: artifactFixture(), baseUrl: 'https://other.invalid/' })).rejects.toThrow('hosting application');
  expect(fetch).not.toHaveBeenCalled();
});
it('reports HTTP failure before trying to import the runtime module', async () => {
  prepare({ bytes: new Uint8Array(8), status: 404 });
  await expect(loadCoreFactory({ artifact: artifactFixture(), baseUrl: 'https://naidan.invalid/nested/' })).rejects.toThrow('404');
});
it('does not import JavaScript when decompressed bytes exceed the verified size', async () => {
  prepare({ bytes: new Uint8Array(64), status: 200 });
  const artifact = { ...artifactFixture(), wasmBytes: 8 };
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/nested/' })).rejects.toThrow('exceeds manifest');
});
it('rejects truncated and corrupted Wasm before module import', async () => {
  prepare({ bytes: new Uint8Array(4), status: 200 });
  const artifact = { ...artifactFixture(), wasmBytes: 8 };
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/' })).rejects.toThrow('Truncated');
  prepare({ bytes: new Uint8Array(8), status: 200 });
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/' })).rejects.toThrow('integrity mismatch');
});
it('fetches from the hosted subdirectory with redirects disabled', async () => {
  prepare({ bytes: new Uint8Array(4), status: 200 });
  const artifact = { ...artifactFixture(), wasmBytes: 8 };
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/nested/' })).rejects.toThrow('Truncated');
  expect(fetch).toHaveBeenCalledWith(new URL(artifact.wasmPath, 'https://naidan.invalid/nested/'), { credentials: 'same-origin', redirect: 'error' });
});
