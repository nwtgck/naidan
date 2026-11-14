// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { PluginContext } from 'rolldown';
import { runtimeAssetMiddleware } from '../../../build/runtime-asset-middleware.test-support';
import { createProfilingArtifactFixture } from '../../../build/llama-gpu-profile.test-support';
import { readLlamaArtifactPackage } from '@/features/llama-cpp-browser/build-artifact-package';
import { assertStandaloneImageModule, createStableDiffusionCppBrowserBuild, readImageArtifacts } from './build-runtime';
import { imageRuntimeSchemaFixture } from './test-utils/runtime-schema.test-support';
const directories: string[] = [];
const hostModuleSources = {
  'api/schema.mjs': 'export default { fixtureOnly: true };',
  'api/functions.mjs': "export { functionSupport as functionsFixture } from './nested/function-support.mjs';",
  'api/nested/function-support.mjs': 'export const functionSupport = true;',
  'host/abi.mjs': "export { abiSupport as abiFixture } from './nested/abi-support.mjs';",
  'host/nested/abi-support.mjs': 'export const abiSupport = true;',
  'host/bindings.mjs': "export { abiFixture as bindingsFixture } from './abi.mjs';",
  'host/read-only-file.mjs': 'export const fileFixture = true;',
  'host/index.mjs': `\
import schema from '../api/schema.mjs';
import { functionsFixture } from '../api/functions.mjs';
import { bindingsFixture } from './bindings.mjs';
import { fileFixture } from './read-only-file.mjs';
export const fixtureReady = schema.fixtureOnly && functionsFixture && bindingsFixture && fileFixture;
`,
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('lazy image runtime assets', () => {
  it('registers middleware without opening the configured artifact directory', async () => {
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', '/missing-image-runtime-for-lazy-test');
    const { plugin } = createStableDiffusionCppBrowserBuild({ rootDir: '/missing', mode: 'hosted' });
    const middleware = await runtimeAssetMiddleware({ plugin, base: '/app/' });
    expect((await middleware.request({ url: '/app/src/main.ts' })).bytes).toBeUndefined();
  });

  it('prepares only the requested Wasm and retries a corrected payload without changing the catalog', async () => {
    const { directory, sourceCommit } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const filename = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.wasm');
    const original = readFileSync(filename);
    writeFileSync(filename, Buffer.alloc(original.length));
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', directory);
    const build = createStableDiffusionCppBrowserBuild({ rootDir: directory, mode: 'hosted' });
    const middleware = await runtimeAssetMiddleware({ plugin: build.plugin, base: '/app/' });
    const load = build.plugin.load;
    if (typeof load !== 'function') {
      throw new Error('Expected the configuration loader.');
    }
    expect(await load.call({} as never, '\0virtual:stable-diffusion-cpp-browser/config')).toContain(sourceCommit);
    expect(build.getNativeLicenseSource()).toBeDefined();
    const prefix = `/app/stable-diffusion-cpp-runtime/${sourceCommit}/`;
    const valid = await middleware.request({ url: prefix + 'webgpu-wasm32-asyncify/core.wasm.gz' });
    expect(valid.status).toBe(200);
    expect(valid.headers.get('Content-Type')).toBe('application/gzip');
    expect(valid.headers.has('Content-Encoding')).toBe(false);
    expect(valid.bytes && gunzipSync(valid.bytes)).toEqual(original);
    const request = { url: prefix + 'webgpu-wasm32-jspi/core.wasm.gz' };
    await expect(middleware.request(request)).rejects.toThrow('integrity mismatch');
    writeFileSync(filename, original);
    const corrected = await middleware.request(request);
    expect(corrected.bytes && gunzipSync(corrected.bytes)).toEqual(original);
  });

  it('uses the current build generation for HTTP delivery and emits the same verified bytes', async () => {
    const first = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const second = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const nextCommit = 'b'.repeat(40);
    changeImageManifest({ directory: second.directory, change: json => json.replaceAll(second.sourceCommit, nextCommit) });
    const nextRootPath = path.join(second.directory, 'manifest.json');
    const nextRoot = JSON.parse(readFileSync(nextRootPath, 'utf8'));
    nextRoot.sourceCommit = nextCommit;
    writeFileSync(nextRootPath, JSON.stringify(nextRoot));
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', first.directory);
    const { plugin, getNativeLicenseSource } = createStableDiffusionCppBrowserBuild({ rootDir: first.directory, mode: 'hosted' });
    const middleware = await runtimeAssetMiddleware({ plugin, base: '/app/' });
    const firstSource = getNativeLicenseSource();
    expect((await middleware.request({ url: `/app/stable-diffusion-cpp-runtime/${first.sourceCommit}/webgpu-wasm32-jspi/core.wasm.gz` })).status).toBe(200);
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', second.directory);
    if (typeof plugin.buildStart !== 'function' || typeof plugin.generateBundle !== 'function') {
      throw new Error('Expected lifecycle hooks.');
    }
    await plugin.buildStart.call({} as never, {} as never);
    expect(getNativeLicenseSource()?.manifestPaths).not.toEqual(firstSource?.manifestPaths);
    const fileName = `stable-diffusion-cpp-runtime/${nextCommit}/webgpu-wasm32-jspi/core.wasm.gz`;
    const response = await middleware.request({ url: '/app/' + fileName });
    const emitted = new Map<string, Uint8Array>();
    const emitFile: PluginContext['emitFile'] = file => {
      if (file.type !== 'asset' || file.fileName === undefined || file.source === undefined) {
        throw new Error('Expected a runtime asset.');
      }
      emitted.set(file.fileName, typeof file.source === 'string' ? Buffer.from(file.source) : file.source);
      return file.fileName;
    };
    await plugin.generateBundle.call({ emitFile } as never, {} as never, {} as never, false);
    expect(response.bytes).toBe(emitted.get(fileName));
    expect((await middleware.request({ url: '/app/stable-diffusion-cpp-runtime/missing/core.wasm.gz' })).status).toBe(404);
  });
});

function fixture({ omitFunction, mutateSchema }: { omitFunction: string | undefined, mutateSchema: ((schema: ReturnType<typeof imageRuntimeSchemaFixture>) => void) | undefined }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'naidan-image-artifact-'));
  directories.push(directory);
  const sourceCommit = 'a'.repeat(40);
  const files: { path: string, bytes: number, sha256: string }[] = [];
  const profiles: Record<string, unknown> = {};
  const add = ({ relative, data }: { relative: string, data: Buffer }) => {
    const absolute = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core', relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, data);
    files.push({ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  };
  for (const profile of ['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']) {
    for (const [extension, data] of Object.entries({ wasm: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), mjs: Buffer.from('export default () => { throw Error("fixture only"); };'), 'd.ts': Buffer.from('export {};') })) {
      add({ relative: `profiles/${profile}/browser/core.${extension}`, data });
    }
    profiles[profile] = { variants: { browser: { sourceCommit, sourceDirty: false, profile, variant: 'browser', configuration: { webgpu: true, pthreads: false, memory64: profile.includes('wasm64'), jspi: profile.endsWith('jspi'), asyncify: profile.endsWith('asyncify') }, validation: { compiled: true, browserSmoke: true, fixtureOnly: true, realModelInference: false } } } };
  }
  const contract = imageRuntimeSchemaFixture();
  contract.schemaSha256 = 'c'.repeat(64);
  contract.functions = contract.functions.filter(entry => entry.name !== omitFunction);
  mutateSchema?.(contract);
  const schema = Buffer.from(JSON.stringify(contract));
  const schemaSha256 = contract.schemaSha256;
  add({ relative: 'api/schema.json', data: schema });
  for (const [relative, source] of Object.entries(hostModuleSources)) {
    add({ relative, data: Buffer.from(source) });
  }
  add({ relative: 'host/README.md', data: Buffer.from('fixture module documentation') });
  add({ relative: 'api/functions.d.ts', data: Buffer.from('export {};') });
  add({ relative: 'tools/not-a-host-module.mjs', data: Buffer.from('throw new Error("Build-only fixture must not be emitted");') });
  add({ relative: 'LICENSE', data: Buffer.from('fixture license') });
  add({ relative: 'licenses/test.txt', data: Buffer.from('fixture notice') });
  const image = { formatVersion: 2, runtime: 'stable-diffusion-cpp', abiVersion: 3, schemaSha256, capabilities: { ggufFileOffsetBits: 64, callerOwnedRandomAccess: true, upstreamApi: true }, sourceCommit, experimental: true, files, profiles };
  const inner = Buffer.from(JSON.stringify(image));
  writeFileSync(path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/manifest.json'), inner);
  const root = { formatVersion: 5, sourceCommit, runtimes: { 'llama-cpp': { manifest: 'runtimes/llama-cpp-browser-core/manifest.json', manifestFormatVersion: 2 }, 'stable-diffusion-cpp': { manifest: 'runtimes/stable-diffusion-cpp-browser-core/manifest.json', manifestFormatVersion: 2 } }, files: [{ path: 'runtimes/stable-diffusion-cpp-browser-core/manifest.json', bytes: inner.length, sha256: createHash('sha256').update(inner).digest('hex') }] };
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(root));
  return { directory, sourceCommit };
}

describe('optional image build integration', () => {
  it('selects separate dependency directories even when their artifact source commits differ', () => {
    using llama = createProfilingArtifactFixture({ diagnostic: 'missing', legacyCpu64: false });
    const image = fixture({ omitFunction: undefined, mutateSchema: undefined });
    cpSync(image.directory, path.join(llama.root, 'node_modules/stable-diffusion-cpp-browser-core'), { recursive: true });
    const language = readLlamaArtifactPackage({ rootDir: llama.root });
    const result = readImageArtifacts({ rootDir: llama.root, mode: 'hosted', artifactDir: undefined });
    expect(result.configuration).toMatchObject({ kind: 'available', sourceCommit: image.sourceCommit });
    expect(language.sourceCommit).not.toBe(image.sourceCommit);
    expect(path.resolve(language.runtimeRoot)).toBe(path.join(llama.packageRoot, 'runtimes/llama-cpp-browser-core'));
    expect(result.nativeLicenseSource?.manifestPaths).toContain(path.join(llama.root, 'node_modules/stable-diffusion-cpp-browser-core/manifest.json'));
  });

  it('allows the passive engine panel and pure observer without admitting native readers', () => {
    const rootDir = '/fixture';
    const id = ({ file }: { file: string }) => path.join(rootDir, 'src/features/stable-diffusion-cpp-browser', file);
    expect(() => assertStandaloneImageModule({ rootDir, id: id({ file: 'components/ImageEngineState.vue' }) })).not.toThrow();
    expect(() => assertStandaloneImageModule({ rootDir, id: id({ file: 'use-image-engine-state.ts' }) })).not.toThrow();
    expect(() => assertStandaloneImageModule({ rootDir, id: '/fixture/node_modules/stable-diffusion-cpp-browser-core/runtimes/stable-diffusion-cpp-browser-core/host/index.mjs' })).toThrow('Hosted image artifact');
    for (const file of ['engine-state.ts', 'worker/engine-state.ts', 'worker/client-hosted.ts', 'worker/impl.ts']) {
      expect(() => assertStandaloneImageModule({ rootDir, id: id({ file }) })).toThrow('Hosted image implementation');
    }
  });

  it('does not require artifacts in standalone or when not installed', () => {
    expect(readImageArtifacts({ rootDir: '/missing', mode: 'standalone', artifactDir: '/invalid' }).configuration).toEqual({ kind: 'unavailable', reason: 'standalone' });
    expect(readImageArtifacts({ rootDir: '/missing', mode: 'hosted', artifactDir: undefined }).files.size).toBe(0);
  });

  it('does not silently ignore an explicit invalid install path', () => {
    expect(() => readImageArtifacts({ rootDir: '/missing', mode: 'hosted', artifactDir: '/invalid-image-artifacts' })).toThrow('does not exist');
  });

  it('defaults old manifests to limited GGUF support and exposes the verified original-shape capability', () => {
    const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    expect(readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory }).configuration).toMatchObject({ kind: 'available', runtimeFeatures: { ggufOriginalShapes: false } });
    changeImageManifest({ directory, change: json => json.replace('"upstreamApi":true', '"upstreamApi":true,"ggufOriginalShapes":true') });
    expect(readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory }).configuration).toMatchObject({ kind: 'available', runtimeFeatures: { ggufOriginalShapes: true } });
  });

  it('binds BF16 retention claims to each verified artifact and requires the advertised optional API', () => {
    const legacy = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const old = readImageArtifacts({ rootDir: legacy.directory, mode: 'hosted', artifactDir: legacy.directory }).configuration;
    expect(old).toMatchObject({ kind: 'available', runtimeFeatures: { bf16WeightRetention: false } });
    changeImageManifest({ directory: legacy.directory, change: json => json.replace('"upstreamApi":true', '"upstreamApi":true,"bf16WeightRetention":true') });
    expect(() => readImageArtifacts({ rootDir: legacy.directory, mode: 'hosted', artifactDir: legacy.directory })).toThrow('sd_browser_bf16_retention_version');
    const { directory } = fixture({ omitFunction: undefined, mutateSchema: schema => schema.functions.push({ name: 'sd_browser_bf16_retention_version', returnType: 'uint32_t', returnKind: 'unsigned', parameters: [] }) });
    changeImageManifest({ directory, change: json => json.replace('"upstreamApi":true', '"upstreamApi":true,"bf16WeightRetention":true') });
    const { configuration } = readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory });
    expect(configuration).toMatchObject({ kind: 'available', runtimeFeatures: { bf16WeightRetention: true } });
    if (configuration.kind !== 'available') {
      throw new Error('Expected verified artifacts');
    }
    expect(configuration.artifacts).toHaveLength(3);
    expect(configuration.artifacts.every(artifact => artifact.bf16WeightRetention === true)).toBe(true);
  });

  it('rejects an invalid original-shape capability or a capability from a mismatched source', () => {
    const { directory, sourceCommit } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    changeImageManifest({ directory, change: json => json.replace('"upstreamApi":true', '"upstreamApi":true,"ggufOriginalShapes":"true"') });
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('runtime ABI 3');
    changeImageManifest({ directory, change: json => json.replace('"ggufOriginalShapes":"true"', '"ggufOriginalShapes":true').replaceAll(sourceCommit, 'b'.repeat(40)) });
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('Mixed runtime source commits');
  });

  it('validates source-bound artifacts and keeps notices separate from emitted runtime assets', async () => {
    const { directory, sourceCommit } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const { configuration, files } = readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory });
    expect(configuration.kind).toBe('available');
    const prefix = `stable-diffusion-cpp-runtime/${sourceCommit}/`;
    expect([...files.keys()].filter(name => name.startsWith(prefix + 'host/') || name.startsWith(prefix + 'api/')).sort())
      .toEqual(Object.keys(hostModuleSources).map(name => prefix + name).sort());
    const emitted = mkdtempSync(path.join(os.tmpdir(), 'naidan-image-emitted-modules-'));
    directories.push(emitted);
    for (const [name, read] of files) {
      if (!name.endsWith('.mjs')) {
        continue;
      }
      const file = path.join(emitted, name.slice(prefix.length));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, await read());
    }
    const imported: unknown = await import(/* @vite-ignore */ pathToFileURL(path.join(emitted, 'host/index.mjs')).href);
    expect(imported).toMatchObject({ fixtureReady: true });
    expect(files.has(prefix + 'tools/not-a-host-module.mjs')).toBe(false);
    expect([...files.keys()].some(file => file.includes('/licenses/') || file.endsWith('/LICENSE'))).toBe(false);
    const readWasm = files.get(`stable-diffusion-cpp-runtime/${sourceCommit}/webgpu-wasm32-asyncify/core.wasm.gz`);
    expect(readWasm && gunzipSync(await readWasm())).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    expect([...files.keys()].some(file => file.endsWith('.wasm'))).toBe(false);
  });

  it('rejects modified code rather than using a cached/fallback runtime', () => {
    const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    writeFileSync(path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.mjs'), 'changed');
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('size mismatch');
  });

  it.each(['api/functions.mjs', 'host/abi.mjs'])('verifies newly selected helper bytes before emitting %s', relative => {
    const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const file = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core', relative);
    const bytes = readFileSync(file);
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(file, bytes);
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('integrity mismatch');
  });

  it('rejects a different parent source identity', () => {
    const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
    const file = path.join(directory, 'manifest.json');
    const root = JSON.parse(readFileSync(file, 'utf8'));
    root.sourceCommit = 'b'.repeat(40);
    writeFileSync(file, JSON.stringify(root));
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('Mixed runtime');
  });
});

it.each([1, 2])('rejects ABI 1 in manifest format %s rather than pretending it implements the new API', formatVersion => {
  const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
  const imagePath = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/manifest.json');
  const old = JSON.parse(readFileSync(imagePath, 'utf8'));
  old.abiVersion = 1;
  old.formatVersion = formatVersion;
  const bytes = Buffer.from(JSON.stringify(old));
  writeFileSync(imagePath, bytes);
  const rootPath = path.join(directory, 'manifest.json');
  const root = JSON.parse(readFileSync(rootPath, 'utf8'));
  const entry = root.files.find((item: { path: string }) => item.path === 'runtimes/stable-diffusion-cpp-browser-core/manifest.json');
  entry.bytes = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(rootPath, JSON.stringify(root));
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow(formatVersion === 1 ? 'expected format 2' : 'ABI 3');
});

/** Update an inner fixture and its parent digest, without forging file hashes. */
function changeImageManifest({ directory, change }: { directory: string, change: (json: string) => string }): void {
  const file = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/manifest.json');
  const bytes = Buffer.from(change(readFileSync(file, 'utf8')));
  writeFileSync(file, bytes);
  const rootPath = path.join(directory, 'manifest.json');
  const root = JSON.parse(readFileSync(rootPath, 'utf8'));
  const entry = root.files.find((item: { path: string }) => item.path === 'runtimes/stable-diffusion-cpp-browser-core/manifest.json');
  entry.bytes = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(rootPath, JSON.stringify(root));
}

it('rejects compiled-only artifacts until actual browser smoke has passed', () => {
  const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
  changeImageManifest({ directory, change: json => json.replace('"browserSmoke":true', '"browserSmoke":false') });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('browser smoke validation');
});

it('detects same-size module corruption with its digest', () => {
  const { directory } = fixture({ omitFunction: undefined, mutateSchema: undefined });
  const file = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.mjs');
  const bytes = readFileSync(file);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(file, bytes);
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('integrity mismatch');
});

it('rejects an oversized requested payload before loading that payload into memory', async () => {
  const { directory, sourceCommit } = fixture({ omitFunction: undefined, mutateSchema: undefined });
  const file = path.join(directory, 'runtimes/stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.wasm');
  writeFileSync(file, new Uint8Array(8192));
  const result = readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory });
  const readWasm = result.files.get(`stable-diffusion-cpp-runtime/${sourceCommit}/webgpu-wasm32-jspi/core.wasm.gz`);
  if (readWasm === undefined) {
    throw new Error('Expected the requested Wasm loader.');
  }
  await expect(readWasm()).rejects.toThrow('size mismatch');
});

it('rejects image artifacts without the preview setter before accepting the runtime', () => {
  const { directory } = fixture({ omitFunction: 'sd_set_preview_callback', mutateSchema: undefined });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('missing a required upstream function: sd_set_preview_callback');
});

it('rejects image artifacts without the opt-in graph diagnostic setter', () => {
  const { directory } = fixture({ omitFunction: 'sd_set_graph_diagnostics', mutateSchema: undefined });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('missing a required upstream function: sd_set_graph_diagnostics');
});

it('rejects a source-bound ABI 2 package using the legacy image result signature', () => {
  const { directory } = fixture({
    omitFunction: undefined,
    mutateSchema(schema) {
      const generate = schema.functions.find(entry => entry.name === 'generate_image')!;
    generate.parameters[2]!.cType = 'sd_image_t **';
    generate.parameters.push({ kind: 'pointer', cType: 'int *' });
    },
  });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('incompatible upstream function: generate_image');
});

it('rejects a package whose result owner or pixel tile fields are incompatible', () => {
  for (const [record, field] of [['sd_image_result_t', 'image'], ['sd_tiling_params_t', 'tile_size_w']] as const) {
    const { directory } = fixture({
      omitFunction: undefined,
      mutateSchema(schema) {
      schema.records.find(entry => entry.name === record)!.fields.find(entry => entry.name === field)!.kind = 'pointer';
      },
    });
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('incompatible record field: ' + record + '.' + field);
  }
});
