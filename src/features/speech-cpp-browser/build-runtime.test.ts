// @vitest-environment node
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { PluginContext } from 'rolldown';
import { runtimeAssetMiddleware } from '../../../build/runtime-asset-middleware.test-support';
import { createSpeechCppBrowserBuild, readSpeechArtifacts } from './build-runtime';

function artifactFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'naidan-speech-assets-'));
  const directory = path.join(root, 'node_modules/speech-cpp-browser-core');
  const runtime = path.join(directory, 'runtimes/speech-cpp-browser-core');
  const commit = 'a'.repeat(40), fingerprint = 'b'.repeat(64), profile = 'webgpu-wasm64-jspi';
  const functions = ['speech_model_load', 'speech_model_free', 'speech_request_new', 'speech_request_free', 'speech_dialogue_start', 'speech_dialogue_push', 'speech_dialogue_end', 'speech_dialogue_free', 'speech_model_info_open', 'speech_request_set_audio', 'speech_request_set_progress', 'speech_request_cancel', 'speech_transcribe', 'speech_request_result', 'speech_result_text', 'speech_result_stop', 'speech_result_language_count', 'speech_result_language'];
  const payloads = new Map<string, Buffer>([
    ['api/schema.json', Buffer.from(JSON.stringify({ runtime: 'speech-cpp', abiVersion: 3, pointerBytes: 8, schemaSha256: fingerprint, functions: functions.map(name => ({ name, export: '_' + name })), callbacks: ['speech_dialogue_callback', 'speech_progress_callback'].map(name => ({ name })) }))],
    ...['api/schema.mjs', 'api/functions.mjs', 'host/abi.mjs', 'host/index.mjs'].map(name => [name, Buffer.from('// Synthetic asset bytes; no inference implementation.')] as const),
    [`profiles/${profile}/browser/core.mjs`, Buffer.from('// Synthetic module bytes, never executed.')],
    [`profiles/${profile}/browser/core.d.ts`, Buffer.from('// Inventory fixture; not a substitute SDK declaration.')],
    [`profiles/${profile}/browser/core.wasm`, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
  ]);
  const identity = ({ relative, bytes }: { relative: string, bytes: Buffer }) => ({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  for (const [relative, bytes] of payloads) {
    mkdirSync(path.dirname(path.join(runtime, relative)), { recursive: true });
    writeFileSync(path.join(runtime, relative), bytes);
  }
  const manifest = Buffer.from(JSON.stringify({
    formatVersion: 2,
    runtime: 'speech-cpp',
    abiVersion: 3,
    sourceCommit: commit,
    schemaSha256: fingerprint,
    experimental: true,
    capabilities: { ggufFileOffsetBits: 64, callerOwnedRandomAccess: true, upstreamApi: true },
    profiles: { [profile]: { variants: { browser: { sourceCommit: commit, sourceDirty: false, profile, variant: 'browser', configuration: { memory64: true, jspi: true, webgpu: true, pthreads: false }, validation: { compiled: true } } } } },
    files: [...payloads].map(([relative, bytes]) => identity({ relative, bytes })),
  }));
  writeFileSync(path.join(runtime, 'manifest.json'), manifest);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ formatVersion: 6, sourceCommit: commit, runtimes: Object.fromEntries(['llama-cpp', 'stable-diffusion-cpp', 'speech-cpp'].map(name => [name, { manifest: `runtimes/${name}-browser-core/manifest.json`, manifestFormatVersion: 2 }])), files: [identity({ relative: 'runtimes/speech-cpp-browser-core/manifest.json', bytes: manifest })] }));
  return {
    root,
    runtime,
    commit,
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('keeps standalone and an absent installed speech SDK unavailable without acquisition', () => {
  expect(readSpeechArtifacts({ rootDir: '/missing-speech-sdk', mode: 'hosted' }).configuration).toEqual({ kind: 'unavailable', reason: 'artifact_unavailable' });
  expect(readSpeechArtifacts({ rootDir: '/missing-speech-sdk', mode: 'standalone' }).files.size).toBe(0);
});

it('allows standalone model classification while excluding hosted speech code and assets', async () => {
  const rootDir = process.cwd();
  const { plugin, getNativeLicenseSource } = createSpeechCppBrowserBuild({ rootDir, mode: 'standalone' });
  const load = plugin.load;
  const generateBundle = plugin.generateBundle;
  if (typeof load !== 'function' || typeof generateBundle !== 'function') {
    throw new Error('Expected speech boundary hooks');
  }
  expect(getNativeLicenseSource()).toBeUndefined();
  for (const file of ['models.ts', 'worker/model-file.ts', 'worker/client-standalone.ts', 'recognition/models.ts', 'recognition/controller.ts', 'recognition/worker/client-standalone.ts', 'investigation/types.ts', 'investigation/recorder.ts', 'investigation/archive.ts']) {
    expect(load.call({} as never, path.join(rootDir, 'src/features/speech-cpp-browser', file))).toBeUndefined();
  }
  for (const file of ['worker/client-hosted.ts', 'worker/entry.ts', 'worker/native-log-router.ts', 'worker/native-observation.ts', 'recognition/worker/client-hosted.ts', 'recognition/worker/entry.ts', 'recognition/worker/native-model.ts']) {
    expect(() => load.call({} as never, path.join(rootDir, 'src/features/speech-cpp-browser', file))).toThrow('Hosted speech runtime');
  }
  const emitted: unknown[] = [];
  const emitFile: PluginContext['emitFile'] = file => {
    emitted.push(file);
    return 'unexpected';
  };
  await generateBundle.call({ emitFile } as never, {} as never, {} as never, false);
  expect(emitted).toEqual([]);
});

it('reads only speech metadata until its verified Wasm bytes are requested', async () => {
  using fixture = artifactFixture();
  const binary = path.join(fixture.runtime, 'profiles/webgpu-wasm64-jspi/browser/core.wasm');
  const original = readFileSync(binary);
  writeFileSync(binary, Buffer.alloc(original.length));
  const result = readSpeechArtifacts({ rootDir: fixture.root, mode: 'hosted' });
  expect(result.configuration.kind).toBe('available');
  expect(result.nativeLicenseSource?.kind).toBe('installed');
  const load = result.files.get(`speech-cpp-runtime/${fixture.commit}/webgpu-wasm64-jspi/core.wasm.gz`)!;
  await expect(load()).rejects.toThrow('integrity mismatch');
  writeFileSync(binary, original);
  expect(gunzipSync(await load())).toEqual(original);
  expect(result.files.has(`speech-cpp-runtime/${fixture.commit}/host/index.mjs`)).toBe(true);
});

it('delivers the installed speech artifact through HTTP and emission with identical verified gzip bytes', async () => {
  const rootDir = process.cwd();
  const { configuration } = readSpeechArtifacts({ rootDir, mode: 'hosted' });
  if (configuration.kind !== 'available') {
    throw new Error('Install the pinned bicore speech dependency with npm ci');
  }
  const { plugin, getNativeLicenseSource } = createSpeechCppBrowserBuild({ rootDir, mode: 'hosted' });
  expect(getNativeLicenseSource()?.kind).toBe('installed');
  const middleware = await runtimeAssetMiddleware({ plugin, base: '/app/' });
  const response = await middleware.request({ url: '/app/' + configuration.artifact.wasmPath });
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/gzip');
  expect(response.headers.has('Content-Encoding')).toBe(false);
  if (response.bytes === undefined) {
    throw new Error('Missing speech HTTP payload');
  }
  const decoded = gunzipSync(response.bytes);
  expect(decoded.length).toBe(configuration.artifact.wasmBytes);
  expect(createHash('sha256').update(decoded).digest('hex')).toBe(configuration.artifact.wasmSha256);
  const emitted = new Map<string, Uint8Array>();
  const emitFile: PluginContext['emitFile'] = file => {
    if (file.type !== 'asset' || file.fileName === undefined || file.source === undefined) {
      throw new Error('Expected a speech runtime asset');
    }
    emitted.set(file.fileName, typeof file.source === 'string' ? Buffer.from(file.source) : file.source);
    return file.fileName;
  };
  if (typeof plugin.generateBundle !== 'function') {
    throw new Error('Expected hosted speech emission');
  }
  await plugin.generateBundle.call({ emitFile } as never, {} as never, {} as never, false);
  expect(emitted.get(configuration.artifact.wasmPath)).toBe(response.bytes);
  expect(emitted.has(configuration.artifact.modulePath)).toBe(true);
  expect(emitted.has(configuration.artifact.helpersPath)).toBe(true);
  expect([...emitted.keys()].some(relative => relative.endsWith('.wasm') || relative.endsWith('/LICENSE'))).toBe(false);
});
