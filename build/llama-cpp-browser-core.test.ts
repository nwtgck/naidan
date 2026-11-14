// @vitest-environment node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext, SourceTextModule } from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'vite';
import { rolldown } from 'rolldown';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { createLlamaCppBrowserBuild } from '../src/features/llama-cpp-browser/build-core';
import catalog from 'llama-cpp-browser-core/llama-cpp/api/schema.mjs';
import * as artifactPackage from '../src/features/llama-cpp-browser/build-artifact-package';
import { createProfilingArtifactFixture } from './llama-gpu-profile.test-support';

const repo = process.cwd();
const profiles = ['cpu-wasm32', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'webgpu-wasm64-jspi', ...(existsSync(path.join(repo, 'node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles/webgpu-wasm64-jspi-gpu-profile/browser/core.wasm')) ? ['webgpu-wasm64-jspi-gpu-profile'] : [])];
const q8SchemaPath = path.join(repo, 'node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles/webgpu-wasm64-jspi-gpu-profile/browser/q8-diagnostic-v1.schema.json');
const q8SchemaAssetName = 'llama-cpp-browser-runtime/profiles/webgpu-wasm64-jspi-gpu-profile/q8-diagnostic-v1.schema.json';

const callbackGetters = [
  'ggml_op_desc', 'ggml_backend_buffer_name', 'ggml_backend_buffer_is_host',
  'ggml_backend_dev_count', 'ggml_backend_dev_get', 'ggml_backend_dev_name', 'ggml_backend_dev_supports_op',
] as const;

async function moduleNamespace({ source }: { source: unknown }) {
  if (typeof source !== 'string') {
    throw new Error('Expected virtual module source');
  }
  const module = new SourceTextModule(source);
  await module.link(() => {
    throw new Error('Runtime identity must not import a manifest');
  });
  await module.evaluate();
  return module.namespace;
}

describe('shared browser core package integration', () => {
  it('keeps runtime identity separate from startup capabilities and watches both manifests', async () => {
    const artifact = artifactPackage.readLlamaArtifactPackage({ rootDir: repo });
    const { resolveId, load } = createLlamaCppBrowserBuild({ rootDir: repo, mode: 'hosted' }).corePlugin;
    if (typeof resolveId !== 'function' || typeof load !== 'function') {
      throw new Error('Expected availability hooks');
    }
    const availabilityId = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/availability', undefined, {} as never);
    const availability = await moduleNamespace({ source: await load.call({ addWatchFile() {} } as never, String(availabilityId)) });
    expect(Object.keys(availability).sort()).toEqual(['gpuProfilingAvailable', 'q8KernelDiagnosticSchemaAsset']);
    const id = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/runtime-build', undefined, {} as never);
    const watched: string[] = [];
    const source = await load.call({ addWatchFile: (file: string) => watched.push(file) } as never, String(id));
    const exports = await moduleNamespace({ source });
    expect(Object.keys(exports)).toEqual(['runtimeBuild']);
    expect(Reflect.get(exports, 'runtimeBuild')).toEqual({
      sourceCommit: artifact.sourceCommit,
      files: [...artifact.files.values()].filter(file => file.path.startsWith('profiles/') || file.path.startsWith('api/'))
        .map(file => ({ ...file, path: `runtimes/llama-cpp-browser-core/${file.path}` })),
    });
    expect(watched).toEqual(expect.arrayContaining(artifact.manifestPaths));
  });

  it.each(['hosted', 'standalone'] as const)('keeps diagnostics evidence outside the initial module closure in %s', async mode => {
    const { resolveId, load } = createLlamaCppBrowserBuild({ rootDir: repo, mode }).corePlugin;
    if (typeof resolveId !== 'function' || typeof load !== 'function') {
      throw new Error('Expected virtual module hooks');
    }
    const runtimeBuildId = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/runtime-build', undefined, {} as never);
    const bundle = await rolldown({
      input: 'fixture:initial',
      plugins: [{
        name: 'lazy-diagnostics-fixture',
        resolveId(source, importer, options) {
          if (source.startsWith('fixture:')) {
            return source;
          }
          return resolveId.call(this as never, source, importer, options as never);
        },
        load(id) {
          if (id === 'fixture:initial') {
            return `\
import * as availability from 'virtual:llama-cpp-browser-core/availability';
export { availability };
export const openDiagnostics = () => import('fixture:diagnostics');
`;
          }
          if (id === 'fixture:diagnostics') {
            return "export { runtimeBuild } from 'virtual:llama-cpp-browser-core/runtime-build';";
          }
          return load.call(this as never, id);
        },
      }],
    });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await bundle.close();
      },
    };
    const { output } = await bundle.generate({ format: 'es' });
    const chunks = output.filter(item => item.type === 'chunk');
    const entry = chunks.find(chunk => chunk.isEntry);
    if (!entry) {
      throw new Error('Expected initial fixture chunk');
    }
    const byFile = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
    const initialFiles = new Set<string>();
    const pending = [entry.fileName];
    for (const fileName of pending) {
      if (initialFiles.has(fileName)) {
        continue;
      }
      initialFiles.add(fileName);
      pending.push(...byFile.get(fileName)!.imports);
    }
    const moduleIds = chunks.filter(chunk => initialFiles.has(chunk.fileName)).flatMap(chunk => Object.keys(chunk.modules));
    expect(moduleIds).not.toContain(runtimeBuildId);
    expect(chunks.filter(chunk => !initialFiles.has(chunk.fileName)).flatMap(chunk => Object.keys(chunk.modules))).toContain(runtimeBuildId);
  });

  it('leaves runtime identity unavailable when an older current-format manifest omits its runtime name', async () => {
    using fixture = createProfilingArtifactFixture();
    const { resolveId, load } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' }).corePlugin;
    if (typeof resolveId !== 'function' || typeof load !== 'function') {
      throw new Error('Expected availability hooks');
    }
    const id = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/runtime-build', undefined, {} as never);
    const source = await load.call({ addWatchFile() {} } as never, String(id));
    const exports = await moduleNamespace({ source });
    expect(Object.hasOwn(exports, 'runtimeBuild')).toBe(true);
    expect(Reflect.get(exports, 'runtimeBuild')).toBeUndefined();
  });

  it('refreshes identity after either manifest changes and retries a failed refresh without another event', async () => {
    using fixture = createProfilingArtifactFixture();
    const artifact = artifactPackage.readLlamaArtifactPackage({ rootDir: fixture.root });
    using read = vi.spyOn(artifactPackage, 'readLlamaArtifactPackage');
    const { resolveId, load, watchChange } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' }).corePlugin;
    if (typeof resolveId !== 'function' || typeof load !== 'function' || typeof watchChange !== 'function') {
      throw new Error('Expected availability hooks');
    }
    const id = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/runtime-build', undefined, {} as never);
    const initial = await moduleNamespace({ source: await load.call({ addWatchFile() {} } as never, String(id)) });
    expect(Reflect.get(initial, 'runtimeBuild')).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    await watchChange.call({} as never, fixture.file({ profile: 'cpu-wasm32', name: 'core.mjs' }), { event: 'update' });
    await load.call({ addWatchFile() {} } as never, String(id));
    expect(read).toHaveBeenCalledTimes(1);

    let reads = 1;
    for (const [index, manifestPath] of artifact.manifestPaths.entries()) {
      await watchChange.call({} as never, manifestPath, { event: 'update' });
      // A partially written package must fail without clearing the pending refresh.
      writeFileSync(artifact.manifestPaths[0]!, '{');
      expect(() => load.call({ addWatchFile() {} } as never, String(id))).toThrow();
      const sourceCommit = String(index + 2).repeat(40);
      const relative = 'runtimes/llama-cpp-browser-core/manifest.json';
      const data = Buffer.from(JSON.stringify({ ...artifact.runtimeMetadata, runtime: 'llama-cpp', sourceCommit }));
      writeFileSync(artifact.manifestPaths[1]!, data);
      writeFileSync(artifact.manifestPaths[0]!, JSON.stringify({
        formatVersion: 5,
        sourceCommit,
        runtimes: {
          'llama-cpp': { manifest: relative, manifestFormatVersion: 2 },
          'stable-diffusion-cpp': { manifest: 'runtimes/stable-diffusion-cpp-browser-core/manifest.json', manifestFormatVersion: 2 },
        },
        files: [{ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }],
      }));
      const exports = await moduleNamespace({ source: await load.call({ addWatchFile() {} } as never, String(id)) });
      expect(Reflect.get(exports, 'runtimeBuild')).toEqual({
        sourceCommit,
        files: artifact.runtimeMetadata.files.filter(file => file.path.startsWith('profiles/') || file.path.startsWith('api/'))
          .map(file => ({ ...file, path: `runtimes/llama-cpp-browser-core/${file.path}` })),
      });
      reads += 2;
      expect(read).toHaveBeenCalledTimes(reads);
      await load.call({ addWatchFile() {} } as never, String(id));
      expect(read).toHaveBeenCalledTimes(reads);
    }
  });

  it('keeps the committed dependency and lock entry on the same immutable artifact', () => {
    const dependencyName = 'llama-cpp-browser-core';
    const packageFile = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')));
    const lockFile = z.object({
      packages: z.object({
        '': z.object({ dependencies: z.record(z.string(), z.string()) }),
        'node_modules/llama-cpp-browser-core': z.object({ resolved: z.string(), integrity: z.string() }),
      }),
    }).parse(JSON.parse(readFileSync(path.join(repo, 'package-lock.json'), 'utf8')));
    const specifier = packageFile.dependencies[dependencyName];
    expect(specifier).toMatch(/^github:nwtgck\/browser-inference-core#[0-9a-f]{40}$/);
    expect(lockFile.packages[''].dependencies[dependencyName]).toBe(specifier);
    const entry = lockFile.packages['node_modules/llama-cpp-browser-core'];
    expect(entry.resolved).toBe(`git+ssh://git@github.com/nwtgck/browser-inference-core.git#${specifier?.split('#')[1]}`);
    expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it('ships the versioned callback metadata exports declared by the pinned package', () => {
    const base = path.join(repo, 'node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/api');
    const schema = z.object({
      abiVersion: z.literal(3),
      callbackMetadata: z.object({ version: z.literal(2), getters: z.array(z.object({ name: z.string(), export: z.string() })) }),
    }).parse(JSON.parse(readFileSync(path.join(base, 'schema.json'), 'utf8')));
    const exports = z.array(z.string()).parse(JSON.parse(readFileSync(path.join(base, 'exports.json'), 'utf8')));
    expect(schema.callbackMetadata.getters).toEqual(expect.arrayContaining(callbackGetters.map(name => ({ name, export: `_${name}` }))));
    expect(exports).toContain('_bicore_abi_version');
    for (const name of callbackGetters) {
      expect(exports).toContain(`_${name}`);
    }
  });

  // Compressing and verifying every real Wasm profile can exceed 5s on busy CI workers.
  it('reads the combined inventory and emits the available verified Hosted Wasm payloads without retired CPU64', async () => {
    const files = new Map<string, Uint8Array>();
    const hook = createLlamaCppBrowserBuild({ rootDir: repo, mode: 'hosted' }).runtimeAssetsPlugin.generateBundle;
    if (typeof hook !== 'function') {
      throw new Error('Expected hosted asset hook');
    }
    await hook.call({
      emitFile(file: { type: string, fileName?: string, source?: Uint8Array }) {
        if (file.type !== 'asset' || !file.fileName || !file.source) {
          throw new Error('Unexpected runtime emission');
        }
        files.set(file.fileName, file.source);
        return file.fileName;
      },
    } as never, {} as never, {} as never, false);
    expect([...files.keys()].sort()).toEqual([
      ...profiles.map(profile => `llama-cpp-browser-runtime/profiles/${profile}/core.wasm.gz`),
      ...(existsSync(q8SchemaPath) ? [q8SchemaAssetName] : []),
    ].sort());
    for (const profile of profiles) {
      const name = `llama-cpp-browser-runtime/profiles/${profile}/core.wasm.gz`;
      const bytes = files.get(name);
      if (!bytes) {
        throw new Error(`Missing hosted runtime asset: ${profile}`);
      }
      expect(gunzipSync(bytes).equals(readFileSync(path.join(repo, `node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles/${profile}/browser/core.wasm`)))).toBe(true);
    }
    if (existsSync(q8SchemaPath)) {
      const schema = files.get(q8SchemaAssetName);
      if (!schema) {
        throw new Error('Missing emitted Q8 diagnostic schema');
      }
      expect(Buffer.from(schema)).toEqual(readFileSync(q8SchemaPath));
    }
  }, 30_000);

  it.each(profiles)('loads the package source for %s at the same virtual dev boundary used by production', async profile => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-core-dev-'));
    const server = await createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [createLlamaCppBrowserBuild({ rootDir: repo, mode: 'hosted' }).corePlugin],
      server: { middlewareMode: true, fs: { allow: [repo, root] }, watch: null },
    });
    await using _cleanupResource = {
      async [Symbol.asyncDispose]() {
        await server.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
    const id = `virtual:llama-cpp-browser-core/${profile}`;
    const realPath = path.join(repo, `node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles/${profile}/browser/core.mjs`);
    const resolved = await server.environments.client.pluginContainer.resolveId(id);
    expect(resolved?.id).toBe(realPath);
    expect(server.config.optimizeDeps.exclude).toContain(id);
    expect(server.config.optimizeDeps.exclude).toContain('llama-cpp-browser-core');
    writeFileSync(path.join(root, 'main.js'), `export const load = () => import(${JSON.stringify(id)});`);
    const importer = await server.transformRequest('/main.js');
    expect(importer?.code).toContain(`/@fs${realPath}`);
    const result = await server.transformRequest(`/@fs${realPath}`);
    expect(result?.code).not.toContain('Naidan fix:');
    expect(result?.code).not.toContain('node:module');
    expect(result?.code).not.toContain('node:crypto');
    expect(result?.code).not.toContain('core.wasm?');
    expect(result?.code).not.toContain('browser-external');
    const source = readFileSync(realPath, 'utf8');
    expect(source).toContain('@vite-ignore');
    expect(source.includes('hostNavigator')).toBe(profile.startsWith('webgpu-'));
    const load = createLlamaCppBrowserBuild({ rootDir: repo, mode: 'hosted' }).corePlugin.load;
    if (typeof load !== 'function') {
      throw new Error('Expected a load hook');
    }
    expect(await load.call({ addWatchFile() {} } as never, realPath)).toBe(source);
  });

  it.each(['cpu-wasm32', 'webgpu-wasm64-jspi'] as const)('accepts a consistent package revision for %s and still rejects corrupted input', async profile => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-core-pin-'));
    using _cleanupResource = {
      [Symbol.dispose]() {
        rmSync(root, { recursive: true, force: true });
      },
    };
    const artifact = path.join(root, 'node_modules/llama-cpp-browser-core');
    cpSync(path.join(repo, 'node_modules/llama-cpp-browser-core'), artifact, { recursive: true });
    const relative = `runtimes/llama-cpp-browser-core/profiles/${profile}/browser/core.mjs`;
    const data = Buffer.from(readFileSync(path.join(artifact, relative), 'utf8') + '\n');
    const updates = [{ relative, data }];
    const mode = profile === 'cpu-wasm32' ? 'hosted' : 'standalone';
    if (mode === 'standalone') {
      const wasmRelative = relative.replace('core.mjs', 'core.wasm');
      // Append an empty custom section so the revised binary remains valid Wasm.
      updates.push({ relative: wasmRelative, data: Buffer.concat([readFileSync(path.join(artifact, wasmRelative)), Buffer.from([0, 1, 0])]) });
    }
    const inventory = z.object({ files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })) }).passthrough();
    const innerPath = path.join(artifact, 'runtimes/llama-cpp-browser-core/manifest.json');
    const inner = inventory.parse(JSON.parse(readFileSync(innerPath, 'utf8')));
    const rootPath = path.join(artifact, 'manifest.json');
    const rootManifest = inventory.parse(JSON.parse(readFileSync(rootPath, 'utf8')));
    for (const update of updates) {
      writeFileSync(path.join(artifact, update.relative), update.data);
      const innerFile = inner.files.find(file => file.path === update.relative.slice('runtimes/llama-cpp-browser-core/'.length));
      if (!innerFile) {
        throw new Error('Missing test inventory entries');
      }
      for (const file of [innerFile]) {
        file.bytes = update.data.length;
        file.sha256 = createHash('sha256').update(update.data).digest('hex');
      }
    }
    const innerData = JSON.stringify(inner);
    writeFileSync(innerPath, innerData);
    const innerManifest = rootManifest.files.find(file => file.path === 'runtimes/llama-cpp-browser-core/manifest.json');
    if (!innerManifest) {
      throw new Error('Missing test runtime manifest');
    }
    innerManifest.bytes = Buffer.byteLength(innerData);
    innerManifest.sha256 = createHash('sha256').update(innerData).digest('hex');
    writeFileSync(rootPath, JSON.stringify(rootManifest));
    const { corePlugin, embeddedBinaries } = createLlamaCppBrowserBuild({ rootDir: root, mode });
    const load = corePlugin.load;
    if (typeof load !== 'function') {
      throw new Error('Expected a load hook');
    }
    expect(await load.call({ addWatchFile() {} } as never, path.join(artifact, relative))).toBe(data.toString('utf8'));
    for (const binary of embeddedBinaries) {
      const bytes = readFileSync(binary.filePath);
      expect(binary.bytes).toBe(bytes.length);
      expect(binary.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    writeFileSync(path.join(artifact, relative), Buffer.concat([data, Buffer.from(' ')]));
    expect(() => load.call({ addWatchFile() {} } as never, path.join(artifact, relative))).toThrow('Bicore artifact integrity mismatch');
    expect(() => createLlamaCppBrowserBuild({ rootDir: root, mode })).toThrow('Bicore artifact integrity mismatch');
  });

  it.each(['complete-buffer', 'partial-view'] as const)('initializes real CPU Wasm from a supplied %s with no fetch or Node imports', async input => {
    const profile = 'cpu-wasm32';
    const id = path.join(repo, `node_modules/llama-cpp-browser-core/runtimes/llama-cpp-browser-core/profiles/${profile}/browser/core.mjs`);
    const source = readFileSync(id, 'utf8');
    const binary = readFileSync(id.replace('core.mjs', 'core.wasm'));
    const storage = new Uint8Array(binary.length + 32);
    storage.set(binary, 16);
    const selected = storage.subarray(16, 16 + binary.length);
    const supplied = input === 'complete-buffer' ? new Uint8Array(selected).buffer : selected;
    const instantiate = vi.fn((bytes: BufferSource, imports: WebAssembly.Imports | undefined) => WebAssembly.instantiate(bytes, imports));
    const wasm = Object.create(WebAssembly);
    wasm.instantiate = instantiate;
    const fetcher = vi.fn(() => {
      throw new Error('Unexpected runtime fetch');
    });
    // Exercise the installed browser factory without a Node-only loading branch.
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
    if (typeof factory !== 'function') {
      throw new Error('Missing core factory');
    }
    const native: unknown = await factory({ wasmBinary: supplied, print() {}, printErr() {} });
    if (typeof native !== 'object' || native === null) {
      throw new Error('Missing native module');
    }
    const version: unknown = Reflect.get(native, '_bicore_abi_version');
    if (typeof version !== 'function') {
      throw new Error('Missing native ABI version');
    }
    expect(Reflect.apply(version, native, [])).toBe(3);
    expect(catalog.callbackMetadata.version).toBe(2);
    for (const name of callbackGetters) {
      const getter = catalog.callbackMetadata.getters.find(getter => getter.name === name);
      expect(getter).toEqual({ name, export: `_${name}` });
      if (getter === undefined) {
        throw new Error(`Missing synchronous callback getter: ${name}`);
      }
      expect(catalog.suspendingExports).not.toContain(getter.export.slice(1));
      expect(typeof Reflect.get(native, getter.export)).toBe('function');
    }
    const count: unknown = Reflect.get(native, '_ggml_backend_dev_count');
    if (typeof count !== 'function') {
      throw new Error('Missing synchronous callback device count');
    }
    const deviceCount: unknown = Reflect.apply(count, native, []);
    expect(typeof deviceCount).toBe('number'); // Native Wasm32 size_t; synchronous, unlike a suspending call.
    expect(deviceCount).toBeGreaterThanOrEqual(0);
    expect(instantiate).toHaveBeenCalledOnce();
    const compiledBytes = instantiate.mock.calls[0]?.[0];
    if (!ArrayBuffer.isView(compiledBytes)) {
      throw new Error('Expected a compiled byte view');
    }
    // Compare the full Wasm payload without expanding its bytes into matcher entries.
    expect(Buffer.from(compiledBytes.buffer, compiledBytes.byteOffset, compiledBytes.byteLength).equals(binary)).toBe(true);
    if (input === 'complete-buffer') {
      expect(compiledBytes.buffer).toBe(supplied);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
