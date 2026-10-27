// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import type { PluginContext } from 'rolldown';
import { runtimeAssetMiddleware } from '../../../build/runtime-asset-middleware.test-support';
import { assertStandaloneImageModule, createStableDiffusionCppBrowserBuild, readImageArtifacts } from './build-runtime';
const directories: string[] = [];

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
    const { directory, sourceCommit } = fixture();
    const filename = path.join(directory, 'stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.wasm');
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
    const first = fixture();
    const second = fixture();
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

function fixture({ omitFunction }: { omitFunction?: string } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'naidan-image-artifact-'));
  directories.push(directory);
  const sourceCommit = 'a'.repeat(40);
  const files: { path: string, bytes: number, sha256: string }[] = [];
  const profiles: Record<string, unknown> = {};
  const add = ({ relative, data }: { relative: string, data: Buffer }) => {
    const absolute = path.join(directory, 'stable-diffusion-cpp-browser-core', relative);
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
  const schema = Buffer.from(JSON.stringify({ abiVersion: 2, functions: ['sd_ctx_params_init', 'sd_img_gen_params_init', 'new_sd_ctx', 'free_sd_ctx', 'generate_image', 'free_sd_images', 'sd_get_model_version_name', 'sd_get_default_sample_method', 'sd_get_default_scheduler', 'sd_cancel_generation', 'sd_set_log_callback', 'sd_set_graph_diagnostics', 'sd_set_progress_callback', 'sd_set_preview_callback', 'sd_ctx_supports_image_generation', 'str_to_sample_method', 'str_to_scheduler'].filter(name => name !== omitFunction).map(name => ({ name })), records: ['sd_ctx_params_t', 'sd_img_gen_params_t', 'sd_image_t', 'sd_sample_params_t', 'sd_guidance_params_t', 'sd_tiling_params_t'].map(name => ({ name })) }));
  const schemaSha256 = createHash('sha256').update(schema).digest('hex');
  add({ relative: 'api/schema.json', data: schema });
  for (const relative of ['api/schema.mjs', 'examples/runtime/index.mjs', 'examples/runtime/bindings.mjs', 'examples/runtime/read-only-file.mjs']) {
    add({ relative, data: Buffer.from('export const fixtureOnly = true;') });
  }
  add({ relative: 'LICENSE', data: Buffer.from('fixture license') });
  add({ relative: 'licenses/test.txt', data: Buffer.from('fixture notice') });
  const image = { formatVersion: 2, runtime: 'stable-diffusion-cpp', abiVersion: 2, schemaSha256, capabilities: { ggufFileOffsetBits: 64, callerOwnedRandomAccess: true, upstreamApi: true }, sourceCommit, experimental: true, files, profiles };
  const inner = Buffer.from(JSON.stringify(image));
  writeFileSync(path.join(directory, 'stable-diffusion-cpp-browser-core/manifest.json'), inner);
  const root = { formatVersion: 3, sourceCommit, files: [...files.map(file => ({ ...file, path: 'stable-diffusion-cpp-browser-core/' + file.path })), { path: 'stable-diffusion-cpp-browser-core/manifest.json', bytes: inner.length, sha256: createHash('sha256').update(inner).digest('hex') }] };
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(root));
  return { directory, sourceCommit };
}

describe('optional image build integration', () => {
  it('allows the passive engine panel and pure observer without admitting native readers', () => {
    const rootDir = '/fixture';
    const id = ({ file }: { file: string }) => path.join(rootDir, 'src/features/stable-diffusion-cpp-browser', file);
    expect(() => assertStandaloneImageModule({ rootDir, id: id({ file: 'components/ImageEngineState.vue' }) })).not.toThrow();
    expect(() => assertStandaloneImageModule({ rootDir, id: id({ file: 'use-image-engine-state.ts' }) })).not.toThrow();
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

  it('validates source-bound artifacts and keeps notices separate from emitted runtime assets', async () => {
    const { directory, sourceCommit } = fixture();
    const { configuration, files } = readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory });
    expect(configuration.kind).toBe('available');
    expect(files.size).toBe(10);
    expect([...files.keys()].some(file => file.includes('/licenses/') || file.endsWith('/LICENSE'))).toBe(false);
    const readWasm = files.get(`stable-diffusion-cpp-runtime/${sourceCommit}/webgpu-wasm32-asyncify/core.wasm.gz`);
    expect(readWasm && gunzipSync(await readWasm())).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    expect([...files.keys()].some(file => file.endsWith('.wasm'))).toBe(false);
  });

  it('rejects modified code rather than using a cached/fallback runtime', () => {
    const { directory } = fixture();
    writeFileSync(path.join(directory, 'stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.mjs'), 'changed');
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('size mismatch');
  });

  it('rejects a different parent source identity', () => {
    const { directory } = fixture();
    const file = path.join(directory, 'manifest.json');
    const root = JSON.parse(readFileSync(file, 'utf8'));
    root.sourceCommit = 'b'.repeat(40);
    writeFileSync(file, JSON.stringify(root));
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('Mixed runtime');
  });
});

it('rejects the previously published ABI 1 rather than pretending it implements the new API', () => {
  const { directory } = fixture();
  const imagePath = path.join(directory, 'stable-diffusion-cpp-browser-core/manifest.json');
  const old = JSON.parse(readFileSync(imagePath, 'utf8'));
  old.abiVersion = 1;
  old.formatVersion = 1;
  const bytes = Buffer.from(JSON.stringify(old));
  writeFileSync(imagePath, bytes);
  const rootPath = path.join(directory, 'manifest.json');
  const root = JSON.parse(readFileSync(rootPath, 'utf8'));
  const entry = root.files.find((item: { path: string }) => item.path === 'stable-diffusion-cpp-browser-core/manifest.json');
  entry.bytes = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(rootPath, JSON.stringify(root));
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('ABI 2');
});

/** Update an inner fixture and its parent digest, without forging file hashes. */
function changeImageManifest({ directory, change }: { directory: string, change: (json: string) => string }): void {
  const file = path.join(directory, 'stable-diffusion-cpp-browser-core/manifest.json');
  const bytes = Buffer.from(change(readFileSync(file, 'utf8')));
  writeFileSync(file, bytes);
  const rootPath = path.join(directory, 'manifest.json');
  const root = JSON.parse(readFileSync(rootPath, 'utf8'));
  const entry = root.files.find((item: { path: string }) => item.path === 'stable-diffusion-cpp-browser-core/manifest.json');
  entry.bytes = bytes.length;
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(rootPath, JSON.stringify(root));
}

it('rejects compiled-only artifacts until actual browser smoke has passed', () => {
  const { directory } = fixture();
  changeImageManifest({ directory, change: json => json.replace('"browserSmoke":true', '"browserSmoke":false') });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('browser smoke validation');
});

it('detects same-size module corruption with its digest', () => {
  const { directory } = fixture();
  const file = path.join(directory, 'stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.mjs');
  const bytes = readFileSync(file);
  bytes[0] = bytes[0]! ^ 1;
  writeFileSync(file, bytes);
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('integrity mismatch');
});

it('rejects an oversized requested payload before loading that payload into memory', async () => {
  const { directory, sourceCommit } = fixture();
  const file = path.join(directory, 'stable-diffusion-cpp-browser-core/profiles/webgpu-wasm32-jspi/browser/core.wasm');
  writeFileSync(file, new Uint8Array(8192));
  const result = readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory });
  const readWasm = result.files.get(`stable-diffusion-cpp-runtime/${sourceCommit}/webgpu-wasm32-jspi/core.wasm.gz`);
  if (readWasm === undefined) {
    throw new Error('Expected the requested Wasm loader.');
  }
  await expect(readWasm()).rejects.toThrow('size mismatch');
});

it('rejects image artifacts without the preview setter before accepting the runtime', () => {
  const { directory } = fixture({ omitFunction: 'sd_set_preview_callback' });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('missing a required upstream function: sd_set_preview_callback');
});

it('rejects image artifacts without the opt-in graph diagnostic setter', () => {
  const { directory } = fixture({ omitFunction: 'sd_set_graph_diagnostics' });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('missing a required upstream function: sd_set_graph_diagnostics');
});
