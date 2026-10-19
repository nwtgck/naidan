// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { createLlamaCppBrowserBuild } from '../src/features/llama-cpp-browser/build-core';
import { createLlamaCppRuntimeAssetsPlugin } from '../src/features/llama-cpp-browser/build-runtime-assets';
import { createProfilingArtifactFixture, diagnosticProfile, ordinaryProfiles } from './llama-gpu-profile.test-support';

async function emitted({ root }: { root: string }) {
  const result = new Map<string, Uint8Array>();
  const hook = createLlamaCppRuntimeAssetsPlugin({ rootDir: root }).generateBundle;
  if (typeof hook !== 'function') {
    throw new Error('Expected a generateBundle hook');
  }
  await hook.call({
    emitFile(file: { fileName: string, source: Uint8Array }) {
      result.set(file.fileName, file.source);
      return file.fileName;
    },
  } as never, {} as never, {} as never, false);
  return result;
}

describe('Hosted-only GPU profiling distribution', () => {
  it('ships five checked payloads and never ships retired CPU64, even in an old package containing it', async () => {
    using fixture = createProfilingArtifactFixture({ legacyCpu64: true });
    const assets = await emitted({ root: fixture.root });
    expect([...assets.keys()].sort()).toEqual([...ordinaryProfiles, diagnosticProfile].map(profile => `llama-cpp-browser-runtime/profiles/${profile}/core.wasm.gz`).sort());
    for (const bytes of assets.values()) {
      expect(gunzipSync(bytes)).toEqual(fixture.wasm);
    }
    const build = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    expect(build.embeddedBinaries).toEqual([]);
  });

  it('retains ordinary Hosted builds before the diagnostic artifact is published and explicitly marks it unavailable', async () => {
    using fixture = createProfilingArtifactFixture({ diagnostic: 'missing', legacyCpu64: true });
    const { corePlugin } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    const { resolveId, load } = corePlugin;
    if (typeof resolveId !== 'function' || typeof load !== 'function') {
      throw new Error('Expected plugin hooks');
    }
    const availability = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/availability', undefined, {} as never);
    expect(await load.call({} as never, String(availability))).toContain('gpuProfilingAvailable = false');
    const fallback = await resolveId.call({} as never, `virtual:llama-cpp-browser-core/${diagnosticProfile}`, undefined, {} as never);
    expect(await load.call({} as never, String(fallback))).toContain('GPU profiling artifact is not installed');
    expect((await emitted({ root: fixture.root })).size).toBe(4);
    expect(() => resolveId.call({} as never, 'virtual:llama-cpp-browser-core/cpu-wasm64', undefined, {} as never)).toThrow('Unavailable');
  });

  it('rejects a partially published profiling profile before any Hosted payload is emitted', async () => {
    using fixture = createProfilingArtifactFixture({ diagnostic: 'partial' });
    expect(() => createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' })).toThrow('Incomplete GPU profiling artifact');
    await expect(emitted({ root: fixture.root })).rejects.toThrow('Incomplete GPU profiling artifact');
  });

  it.each(['core.mjs', 'core.wasm', 'core.d.ts'])('validates the diagnostic %s against both manifests', async name => {
    using fixture = createProfilingArtifactFixture();
    writeFileSync(fixture.file({ profile: diagnosticProfile, name }), 'corrupted after packaging');
    expect(() => createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' })).toThrow('integrity mismatch');
    await expect(emitted({ root: fixture.root })).rejects.toThrow('integrity mismatch');
  });

  it('never reads or embeds diagnostic Wasm in standalone and rejects a direct diagnostic import', async () => {
    using fixture = createProfilingArtifactFixture();
    // Standalone must not even read this unrelated payload for validation.
    writeFileSync(fixture.file({ profile: diagnosticProfile, name: 'core.wasm' }), 'intentionally invalid diagnostic payload');
    const { corePlugin, embeddedBinaries } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'standalone' });
    expect(embeddedBinaries.map(binary => binary.virtualId).sort()).toEqual(['virtual:file-protocol-standalone/binary/llama-cpp-browser', 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi']);
    const { resolveId, load } = corePlugin;
    if (typeof resolveId !== 'function' || typeof load !== 'function') {
      throw new Error('Expected plugin hooks');
    }
    expect(() => resolveId.call({} as never, `virtual:llama-cpp-browser-core/${diagnosticProfile}`, undefined, {} as never)).toThrow('Unavailable');
    expect(() => load.call({} as never, fixture.file({ profile: diagnosticProfile, name: 'core.mjs' }))).toThrow('Unavailable');
    const availability = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/availability', undefined, {} as never);
    expect(await load.call({} as never, String(availability))).toContain('gpuProfilingAvailable = false');
  });

  it('uses the same lazy virtual import and explicit gzip endpoint in Vite development', async () => {
    using fixture = createProfilingArtifactFixture();
    const { corePlugin } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    const server = await createServer({ root: fixture.root, configFile: false, base: '/app/', logLevel: 'silent', plugins: [corePlugin, createLlamaCppRuntimeAssetsPlugin({ rootDir: fixture.root })], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await server.close();
      },
    };
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected local test server');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/app/llama-cpp-browser-runtime/profiles/${diagnosticProfile}/core.wasm.gz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Encoding')).toBeNull();
    expect(gunzipSync(new Uint8Array(await response.arrayBuffer()))).toEqual(fixture.wasm);
    expect((await fetch(`${origin}/app/llama-cpp-browser-runtime/profiles/cpu-wasm64/core.wasm.gz`)).status).toBe(404);
    const id = `virtual:llama-cpp-browser-core/${diagnosticProfile}`;
    const resolved = await server.environments.client.pluginContainer.resolveId(id);
    expect(resolved?.id).toBe(fixture.file({ profile: diagnosticProfile, name: 'core.mjs' }));
    expect(server.config.optimizeDeps.exclude).toContain(id);
    const source = readFileSync(fixture.file({ profile: diagnosticProfile, name: 'core.mjs' }), 'utf8');
    const load = corePlugin.load;
    if (typeof load !== 'function') {
      throw new Error('Expected loader');
    }
    expect(await load.call({ addWatchFile() {} } as never, resolved!.id)).toBe(source);
    expect(cleanup).toBeDefined();
  });
});
