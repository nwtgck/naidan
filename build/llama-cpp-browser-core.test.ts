// @vitest-environment node
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, SourceTextModule } from 'node:vm';
import { createServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { createLlamaCppBrowserBuild, transformBrowserCore } from '../src/features/llama-cpp-browser/build-core';

const repo = process.cwd();
const profiles = ['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi'] as const;
describe('shared browser core adapter', () => {
  it.each(profiles)('transforms %s at the same virtual dev boundary used by production', async profile => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-core-dev-'));
    const server = await createServer({ configFile: false, root, logLevel: 'silent',
      plugins: [createLlamaCppBrowserBuild({ rootDir: repo, mode: 'hosted' }).corePlugin],
      server: { middlewareMode: true, fs: { allow: [repo, root] }, watch: null },
    });
    try {
      const id = `virtual:llama-cpp-browser-core/${profile}`;
      const realPath = path.join(repo, `node_modules/llama-cpp-browser-core/profiles/${profile}/core.mjs`);
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
      expect(adapted.slice(0, start)).toBe(source.slice(0, start));
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
      const relative = 'profiles/cpu-wasm32/core.mjs';
      const data = readFileSync(path.join(artifact, relative), 'utf8') + '\n';
      writeFileSync(path.join(artifact, relative), data);
      // JSON here is an owned fixture; only change its existing reviewed record.
      const manifest = readFileSync(path.join(artifact, 'manifest.json'), 'utf8');
      const original = readFileSync(path.join(repo, 'node_modules/llama-cpp-browser-core', relative));
      writeFileSync(path.join(artifact, 'manifest.json'), manifest
        .replace(createHash('sha256').update(original).digest('hex'), createHash('sha256').update(data).digest('hex'))
        .replace(`"bytes": ${original.byteLength}`, `"bytes": ${Buffer.byteLength(data)}`));
      expect(() => createLlamaCppBrowserBuild({ rootDir: root, mode: 'hosted' })).toThrow('Unreviewed browser core artifact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('initializes real CPU Wasm from the original non-zero-offset byte view with no fetch or Node imports', async () => {
    const profile = 'cpu-wasm32';
    const id = path.join(repo, `node_modules/llama-cpp-browser-core/profiles/${profile}/core.mjs`);
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
    const context = createContext({ WebAssembly: wasm, console, TextEncoder, TextDecoder, URL,
      crypto: globalThis.crypto, performance, setTimeout, clearTimeout,
      fetch: fetcher, WorkerGlobalScope: class {},
    });
    const module = new SourceTextModule(source, { context, initializeImportMeta(meta) {
      meta.url = 'file:///fixture/core.mjs';
    } });
    await module.link(() => {
      throw new Error('Unexpected core dependency');
    });
    await module.evaluate();
    const factory: unknown = Reflect.get(module.namespace, 'default');
    if (typeof factory !== 'function') throw new Error('Missing core factory');
    await factory({ wasmBinary: supplied, print() {}, printErr() {} });
    expect(instantiate).toHaveBeenCalledOnce();
    expect(instantiate.mock.calls[0]?.[0]).toBe(supplied);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
