// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import { readImageArtifacts } from './build-runtime';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture({ omitFunction }: { omitFunction?: string } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'naidan-image-artifact-')); directories.push(directory);
  const sourceCommit = 'a'.repeat(40);
  const files: { path: string, bytes: number, sha256: string }[] = [];
  const profiles: Record<string, unknown> = {};
  const add = ({ relative, data }: { relative: string, data: Buffer }) => {
    const absolute = path.join(directory, 'stable-diffusion-cpp', relative); mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, data);
    files.push({ path: relative, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  };
  for (const profile of ['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']) {
    for (const [extension, data] of Object.entries({ wasm: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), mjs: Buffer.from('export default () => { throw Error("fixture only"); };'), 'd.ts': Buffer.from('export {};') })) add({ relative: `profiles/${profile}/browser/core.${extension}`, data });
    profiles[profile] = { variants: { browser: { sourceCommit, sourceDirty: false, profile, variant: 'browser', configuration: { webgpu: true, pthreads: false, memory64: profile.includes('wasm64'), jspi: profile.endsWith('jspi'), asyncify: profile.endsWith('asyncify') }, validation: { compiled: true, browserSmoke: true, fixtureOnly: true, realModelInference: false } } } };
  }
  const schema = Buffer.from(JSON.stringify({ abiVersion: 2, functions: ['sd_ctx_params_init', 'sd_img_gen_params_init', 'new_sd_ctx', 'free_sd_ctx', 'generate_image', 'free_sd_images', 'sd_get_model_version_name', 'sd_get_default_sample_method', 'sd_get_default_scheduler', 'sd_cancel_generation', 'sd_set_log_callback', 'sd_set_progress_callback', 'sd_set_preview_callback', 'sd_ctx_supports_image_generation', 'str_to_sample_method', 'str_to_scheduler'].filter(name => name !== omitFunction).map(name => ({ name })), records: ['sd_ctx_params_t', 'sd_img_gen_params_t', 'sd_image_t', 'sd_sample_params_t', 'sd_guidance_params_t', 'sd_tiling_params_t'].map(name => ({ name })) }));
  const schemaSha256 = createHash('sha256').update(schema).digest('hex');
  add({ relative: 'api/schema.json', data: schema });
  for (const relative of ['api/schema.mjs', 'examples/runtime/index.mjs', 'examples/runtime/bindings.mjs', 'examples/runtime/read-only-file.mjs']) add({ relative, data: Buffer.from('export const fixtureOnly = true;') });
  add({ relative: 'LICENSE', data: Buffer.from('fixture license') });
  add({ relative: 'licenses/test.txt', data: Buffer.from('fixture notice') });
  const image = { formatVersion: 2, runtime: 'stable-diffusion-cpp', abiVersion: 2, schemaSha256, capabilities: { ggufFileOffsetBits: 64, callerOwnedRandomAccess: true, upstreamApi: true }, sourceCommit, experimental: true, files, profiles };
  const inner = Buffer.from(JSON.stringify(image)); writeFileSync(path.join(directory, 'stable-diffusion-cpp/manifest.json'), inner);
  const root = { formatVersion: 3, sourceCommit, files: [...files.map(file => ({ ...file, path: 'stable-diffusion-cpp/' + file.path })), { path: 'stable-diffusion-cpp/manifest.json', bytes: inner.length, sha256: createHash('sha256').update(inner).digest('hex') }] };
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(root));
  return { directory, sourceCommit };
}
describe('optional image build integration', () => {
  it('does not require artifacts in standalone or when not installed', () => {
    expect(readImageArtifacts({ rootDir: '/missing', mode: 'standalone', artifactDir: '/invalid' }).configuration).toEqual({ kind: 'unavailable', reason: 'standalone' });
    expect(readImageArtifacts({ rootDir: '/missing', mode: 'hosted', artifactDir: undefined }).files.size).toBe(0);
  });
  it('does not silently ignore an explicit invalid install path', () => {
    expect(() => readImageArtifacts({ rootDir: '/missing', mode: 'hosted', artifactDir: '/invalid-image-artifacts' })).toThrow('does not exist');
  });
  it('validates source-bound artifacts and emits gzip plus all notices', () => {
    const { directory, sourceCommit } = fixture();
    const { configuration, files } = readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory });
    expect(configuration.kind).toBe('available');
    expect(files.size).toBe(12);
    const wasm = files.get(`stable-diffusion-cpp-runtime/${sourceCommit}/webgpu-wasm32-asyncify/core.wasm.gz`);
    expect(wasm && gunzipSync(wasm)).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    expect([...files.keys()].some(file => file.endsWith('.wasm'))).toBe(false);
  });
  it('rejects modified code rather than using a cached/fallback runtime', () => {
    const { directory } = fixture(); writeFileSync(path.join(directory, 'stable-diffusion-cpp/profiles/webgpu-wasm32-jspi/browser/core.mjs'), 'changed');
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('size mismatch');
  });
  it('rejects a different parent source identity', () => {
    const { directory } = fixture(); const file = path.join(directory, 'manifest.json'); const root = JSON.parse(readFileSync(file, 'utf8')); root.sourceCommit = 'b'.repeat(40); writeFileSync(file, JSON.stringify(root));
    expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('Mixed runtime');
  });
});

it('rejects the previously published ABI 1 rather than pretending it implements the new API', () => {
  const { directory } = fixture();
  const imagePath = path.join(directory, 'stable-diffusion-cpp/manifest.json');
  const old = JSON.parse(readFileSync(imagePath, 'utf8')); old.abiVersion = 1; old.formatVersion = 1;
  const bytes = Buffer.from(JSON.stringify(old)); writeFileSync(imagePath, bytes);
  const rootPath = path.join(directory, 'manifest.json'); const root = JSON.parse(readFileSync(rootPath, 'utf8'));
  const entry = root.files.find((item: { path: string }) => item.path === 'stable-diffusion-cpp/manifest.json');
  entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex'); writeFileSync(rootPath, JSON.stringify(root));
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('ABI 2');
});

/** Update an inner fixture and its parent digest, without forging file hashes. */
function changeImageManifest({ directory, change }: { directory: string, change: (json: string) => string }): void {
  const file = path.join(directory, 'stable-diffusion-cpp/manifest.json');
  const bytes = Buffer.from(change(readFileSync(file, 'utf8'))); writeFileSync(file, bytes);
  const rootPath = path.join(directory, 'manifest.json'); const root = JSON.parse(readFileSync(rootPath, 'utf8'));
  const entry = root.files.find((item: { path: string }) => item.path === 'stable-diffusion-cpp/manifest.json');
  entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex'); writeFileSync(rootPath, JSON.stringify(root));
}
it('rejects compiled-only artifacts until actual browser smoke has passed', () => {
  const { directory } = fixture();
  changeImageManifest({ directory, change: json => json.replace('"browserSmoke":true', '"browserSmoke":false') });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('browser smoke validation');
});
it('detects same-size module corruption with its digest', () => {
  const { directory } = fixture();
  const file = path.join(directory, 'stable-diffusion-cpp/profiles/webgpu-wasm32-jspi/browser/core.mjs');
  const bytes = readFileSync(file); bytes[0] = bytes[0]! ^ 1; writeFileSync(file, bytes);
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('integrity mismatch');
});
it('rejects an oversized payload before loading that payload into memory', () => {
  const { directory } = fixture();
  const file = path.join(directory, 'stable-diffusion-cpp/profiles/webgpu-wasm32-jspi/browser/core.wasm');
  writeFileSync(file, new Uint8Array(8192));
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('size mismatch');
});

it('rejects image artifacts without the preview setter before accepting the runtime', () => {
  const { directory } = fixture({ omitFunction: 'sd_set_preview_callback' });
  expect(() => readImageArtifacts({ rootDir: directory, mode: 'hosted', artifactDir: directory })).toThrow('missing a required upstream function: sd_set_preview_callback');
});
