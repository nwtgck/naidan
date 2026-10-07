// @vitest-environment node
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, SourceTextModule } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'vite';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { createLlamaCppBrowserBuild, transformBrowserCore } from '../src/features/llama-cpp-browser/build-core';
import { createLlamaCppRuntimeAssetsPlugin } from '../src/features/llama-cpp-browser/build-runtime-assets';

const repo = process.cwd();
const profiles = ['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi'] as const;
describe('shared browser core adapter', () => {
  it('reads the combined inventory and emits five verified hosted Wasm payloads', async () => {
    const files = new Map<string, Uint8Array>();
    const hook = createLlamaCppRuntimeAssetsPlugin({ rootDir: repo }).generateBundle;
    if (typeof hook !== 'function') throw new Error('Expected hosted asset hook');
    await hook.call({
      emitFile(file: { type: string, fileName?: string, source?: Uint8Array }) {
        if (file.type !== 'asset' || !file.fileName || !file.source) throw new Error('Unexpected runtime emission');
        files.set(file.fileName, file.source); return file.fileName;
      },
    } as never, {} as never, {} as never, false);
    expect(files.size).toBe(5);
    for (const profile of profiles) {
      const name = `llama-cpp-browser-runtime/profiles/${profile}/core.wasm.gz`;
      const bytes = files.get(name);
      if (!bytes) throw new Error(`Missing hosted runtime asset: ${profile}`);
      expect(gunzipSync(bytes).equals(readFileSync(path.join(repo, `node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles/${profile}/browser/core.wasm`)))).toBe(true);
    }
  });
  it.each(profiles)('transforms %s at the same virtual dev boundary used by production', async profile => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-core-dev-'));
    const server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [createLlamaCppBrowserBuild({ rootDir: repo, mode: 'hosted' }).corePlugin],
      server: { middlewareMode: true, fs: { allow: [repo, root] }, watch: null },
    });
    try {
      const id = `virtual:llama-cpp-browser-core/${profile}`;
      const realPath = path.join(repo, `node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles/${profile}/browser/core.mjs`);
      const resolved = await server.environments.client.pluginContainer.resolveId(id);
      expect(resolved?.id).toBe(realPath);
      expect(server.config.optimizeDeps.exclude).toContain(id);
      expect(server.config.optimizeDeps.exclude).toContain('llama-cpp-browser-core');
      writeFileSync(path.join(root, 'main.js'), `export const load = () => import(${JSON.stringify(id)});`);
      const importer = await server.transformRequest('/main.js');
      expect(importer?.code).toContain(`/@fs${realPath}`);
      const result = await server.transformRequest(`/@fs${realPath}`);
      expect(result?.code).toContain('Browser core requires supplied wasmBinary');
      expect(result?.code).not.toContain('node:module');
      expect(result?.code).not.toContain('node:crypto');
      expect(result?.code).not.toContain('core.wasm?');
      expect(result?.code).not.toContain('browser-external');
      const source = readFileSync(realPath, 'utf8');
      const start = source.indexOf('var ENVIRONMENT_IS_WEB=');
      const adapted = transformBrowserCore({ source, id: realPath, profile }).code;
      const injection = 'var navigator=Module["naidanNavigator"]??globalThis.navigator;';
      expect(adapted.split(injection)).toHaveLength(profile.startsWith('webgpu-') ? 2 : 1);
      // All other loader prologue bytes remain untouched; the hash guard still
      // rejects every unreviewed native artifact before this scoped insertion.
      expect(adapted.replace(injection, '').slice(0, start)).toBe(source.slice(0, start));
      expect(() => transformBrowserCore({ source: source + '\n', id: realPath, profile })).toThrow('Unreviewed');
    } finally {
      await server.close(); rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects an unreviewed but internally consistent revision when creating the dev plugin, before the first import', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-core-pin-'));
    try {
      const artifact = path.join(root, 'node_modules/llama-cpp-browser-core');
      cpSync(path.join(repo, 'node_modules/llama-cpp-browser-core'), artifact, { recursive: true });
      const relative = 'llama-cpp-browser-core/profiles/cpu-wasm32/browser/core.mjs';
      const data = readFileSync(path.join(artifact, relative), 'utf8') + '\n';
      writeFileSync(path.join(artifact, relative), data);
      // Keep both inventories internally consistent so the exact-source guard
      // rejects this unreviewed browser core rather than a corrupt fixture.
      const inventory = z.object({ files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })) }).passthrough();
      const innerPath = path.join(artifact, 'llama-cpp-browser-core/manifest.json');
      const inner = inventory.parse(JSON.parse(readFileSync(innerPath, 'utf8')));
      const innerFile = inner.files.find(file => file.path === 'profiles/cpu-wasm32/browser/core.mjs');
      if (!innerFile) throw new Error('Missing test core');
      innerFile.bytes = Buffer.byteLength(data); innerFile.sha256 = createHash('sha256').update(data).digest('hex');
      const innerData = JSON.stringify(inner); writeFileSync(innerPath, innerData);
      const rootPath = path.join(artifact, 'manifest.json');
      const rootManifest = inventory.parse(JSON.parse(readFileSync(rootPath, 'utf8')));
      const coreFile = rootManifest.files.find(file => file.path === relative);
      const innerManifest = rootManifest.files.find(file => file.path === 'llama-cpp-browser-core/manifest.json');
      if (!coreFile || !innerManifest) throw new Error('Missing test inventory entries');
      coreFile.bytes = Buffer.byteLength(data); coreFile.sha256 = createHash('sha256').update(data).digest('hex');
      innerManifest.bytes = Buffer.byteLength(innerData); innerManifest.sha256 = createHash('sha256').update(innerData).digest('hex');
      writeFileSync(rootPath, JSON.stringify(rootManifest));
      expect(() => createLlamaCppBrowserBuild({ rootDir: root, mode: 'hosted' })).toThrow('Unreviewed browser core artifact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('initializes real CPU Wasm from the original non-zero-offset byte view with no fetch or Node imports', async () => {
    const profile = 'cpu-wasm32';
    const id = path.join(repo, `node_modules/llama-cpp-browser-core/llama-cpp-browser-core/profiles/${profile}/browser/core.mjs`);
    const source = transformBrowserCore({ source: readFileSync(id, 'utf8'), id, profile }).code;
    const binary = readFileSync(id.replace('core.mjs', 'core.wasm'));
    const storage = new Uint8Array(binary.length + 32);
    storage.set(binary, 16);
    const supplied = storage.subarray(16, 16 + binary.length);
    const instantiate = vi.fn((bytes: BufferSource, imports: WebAssembly.Imports | undefined) => WebAssembly.instantiate(bytes, imports));
    const wasm = Object.create(WebAssembly);
    wasm.instantiate = instantiate;
    const fetcher = vi.fn(() => {
      throw new Error('Unexpected runtime fetch');
    });
    // A browser-like VM proves the adapter rather than relying on a Node-only import branch.
    const context = createContext({
      WebAssembly: wasm,
      console,
      TextEncoder,
      TextDecoder,
      URL,
      crypto: globalThis.crypto,
      performance,
      setTimeout,
      clearTimeout,
      fetch: fetcher,
      WorkerGlobalScope: class {},
    });
    const module = new SourceTextModule(source, {
      context,
      initializeImportMeta(meta) {
        meta.url = 'file:///fixture/core.mjs';
      },
    });
    await module.link(() => {
      throw new Error('Unexpected core dependency');
    });
    await module.evaluate();
    const factory: unknown = Reflect.get(module.namespace, 'default');
    if (typeof factory !== 'function') throw new Error('Missing core factory');
    await factory({ wasmBinary: supplied, print() {}, printErr() {} });
    expect(instantiate).toHaveBeenCalledOnce();
    expect(instantiate.mock.calls[0]?.[0]).toBe(supplied);
    await expect(factory({ printErr() {} })).rejects.toThrow('Browser core requires supplied wasmBinary');
    await expect(factory({ wasmBinary: new Uint8Array(), printErr() {} })).rejects.toThrow('Browser core requires supplied wasmBinary');
    await expect(factory({ wasmBinary: supplied.buffer, printErr() {} })).rejects.toThrow('Expected Wasm byte view');
    expect(instantiate).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
