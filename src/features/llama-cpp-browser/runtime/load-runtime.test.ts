// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadRuntime } from './load-runtime';

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('prebuilt runtime loading', () => {
  it('decompresses the served core asset and initializes the actual supplied CPU Wasm', async () => {
    const base = pathToFileURL(path.resolve('node_modules/llama-cpp-browser-core/profiles') + '/');
    const wasm = await readFile(new URL('cpu-wasm32/core.wasm', base));
    const fetcher = vi.fn().mockResolvedValue(new Response(Uint8Array.from(gzipSync(wasm))));
    vi.stubGlobal('fetch', fetcher);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const core = await loadRuntime({ profile: 'cpu-wasm32', assetBaseURL: base.href });
    try {
      expect(fetcher).toHaveBeenCalledOnce();
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(new URL('cpu-wasm32/core.wasm.gz', base).href);
      expect(core.pointerBytes).toBe(4);
      expect(Object.getPrototypeOf(core.api)).toBeNull();
      expect(await core.api.ggml_backend_dev_count()).toBeGreaterThan(0n);
      expect(JSON.stringify(debug.mock.calls)).toContain('runtime-ready');
      expect(JSON.stringify(debug.mock.calls)).not.toContain(base.href);
    } finally {
      await core.api.llama_backend_free();
    }
  }, 30000);
  it('reports unsupported GPU requirements without fetching a runtime or falling back silently', async () => {
    vi.stubGlobal('navigator', {}); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(loadRuntime({ profile: 'webgpu-wasm64-jspi', assetBaseURL: 'https://example.invalid/runtime/' })).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
