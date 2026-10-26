// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { PluginContext } from 'rolldown';
import { describe, expect, it } from 'vitest';
import { createLlamaCppBrowserBuild } from '../src/features/llama-cpp-browser/build-core';
import { createProfilingArtifactFixture } from './llama-gpu-profile.test-support';
import { runtimeAssetMiddleware } from './runtime-asset-middleware.test-support';

describe('lazy llama runtime assets', () => {
  it('prepares only a requested profile and retries a corrected verified payload', async () => {
    using fixture = createProfilingArtifactFixture({ diagnostic: 'missing', legacyCpu64: false });
    const brokenFile = fixture.file({ profile: 'cpu-wasm32', name: 'core.wasm' });
    writeFileSync(brokenFile, Buffer.alloc(fixture.wasm.length));
    const { runtimeAssetsPlugin } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    const middleware = await runtimeAssetMiddleware({ plugin: runtimeAssetsPlugin, base: '/app/' });
    const prefix = '/app/llama-cpp-browser-runtime/profiles/';
    const valid = await middleware.request({ url: prefix + 'webgpu-wasm32-jspi/core.wasm.gz' });
    expect(valid.status).toBe(200);
    expect(valid.headers.get('Content-Type')).toBe('application/gzip');
    expect(valid.headers.has('Content-Encoding')).toBe(false);
    expect(valid.bytes && gunzipSync(valid.bytes)).toEqual(fixture.wasm);
    const request = { url: prefix + 'cpu-wasm32/core.wasm.gz' };
    await expect(middleware.request(request)).rejects.toThrow('integrity mismatch');
    writeFileSync(brokenFile, fixture.wasm);
    const corrected = await middleware.request(request);
    expect(corrected.bytes).toEqual(gzipSync(fixture.wasm, { level: 9 }));
    expect((await middleware.request({ url: prefix + 'cpu-wasm64/core.wasm.gz' })).status).toBe(404);
  });

  it('shares simultaneous HTTP requests with the identical hosted asset', async () => {
    using fixture = createProfilingArtifactFixture({ diagnostic: 'missing', legacyCpu64: false });
    const { runtimeAssetsPlugin } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    const middleware = await runtimeAssetMiddleware({ plugin: runtimeAssetsPlugin, base: '/app/' });
    const fileName = 'llama-cpp-browser-runtime/profiles/cpu-wasm32/core.wasm.gz';
    const request = { url: '/app/' + fileName };
    const first = middleware.request(request);
    const second = middleware.request(request);
    const bytes = (await first).bytes;
    expect((await second).bytes).toBe(bytes);
    const emitted = new Map<string, Uint8Array>();
    const emitFile: PluginContext['emitFile'] = file => {
      if (file.type !== 'asset' || file.fileName === undefined || file.source === undefined) {
        throw new Error('Expected a runtime asset.');
      }
      emitted.set(file.fileName, typeof file.source === 'string' ? Buffer.from(file.source) : file.source);
      return file.fileName;
    };
    if (typeof runtimeAssetsPlugin.generateBundle !== 'function') {
      throw new Error('Expected hosted emission.');
    }
    await runtimeAssetsPlugin.generateBundle.call({ emitFile } as never, {} as never, {} as never, false);
    expect(emitted.get(fileName)).toBe(bytes);
    expect(emitted.size).toBe(4);
  });

  it('clears prepared bytes at the next buildStart instead of hiding changed inputs', async () => {
    using fixture = createProfilingArtifactFixture({ diagnostic: 'missing', legacyCpu64: false });
    const { runtimeAssetsPlugin } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    const middleware = await runtimeAssetMiddleware({ plugin: runtimeAssetsPlugin, base: '/app/' });
    const request = { url: '/app/llama-cpp-browser-runtime/profiles/cpu-wasm32/core.wasm.gz' };
    expect((await middleware.request(request)).status).toBe(200);
    writeFileSync(fixture.file({ profile: 'cpu-wasm32', name: 'core.wasm' }), Buffer.alloc(fixture.wasm.length));
    if (typeof runtimeAssetsPlugin.buildStart !== 'function') {
      throw new Error('Expected the build lifecycle.');
    }
    await runtimeAssetsPlugin.buildStart.call({} as never, {} as never);
    await expect(middleware.request(request)).rejects.toThrow('integrity mismatch');
  });
});
