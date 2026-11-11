// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { artifactFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { imageRuntimeSchemaFixture } from '@/features/stable-diffusion-cpp-browser/test-utils/runtime-schema.test-support';
import { loadCoreFactory, TEST_ONLY } from './core-loader';

afterEach(() => vi.unstubAllGlobals());

function prepare({ bytes, status }: { bytes: Uint8Array, status: number }): void {
  vi.stubGlobal('self', { location: { origin: 'https://naidan.invalid' } });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(gzipSync(bytes)), { status })));
}

it('rejects a cross-origin runtime base before making any request', async () => {
  prepare({ bytes: new Uint8Array(8), status: 200 });
  await expect(loadCoreFactory({ artifact: artifactFixture(), baseUrl: 'https://other.invalid/' })).rejects.toThrow('hosting application');
  expect(fetch).not.toHaveBeenCalled();
});

it('reports HTTP failure before trying to import the runtime module', async () => {
  prepare({ bytes: new Uint8Array(8), status: 404 });
  await expect(loadCoreFactory({ artifact: artifactFixture(), baseUrl: 'https://naidan.invalid/nested/' })).rejects.toThrow('404');
});

it('does not import JavaScript when decompressed bytes exceed the verified size', async () => {
  prepare({ bytes: new Uint8Array(64), status: 200 });
  const artifact = { ...artifactFixture(), wasmBytes: 8 };
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/nested/' })).rejects.toThrow('exceeds manifest');
});

it('rejects truncated and corrupted Wasm before module import', async () => {
  prepare({ bytes: new Uint8Array(4), status: 200 });
  const artifact = { ...artifactFixture(), wasmBytes: 8 };
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/' })).rejects.toThrow('Truncated');
  prepare({ bytes: new Uint8Array(8), status: 200 });
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/' })).rejects.toThrow('integrity mismatch');
});

it('fetches from the hosted subdirectory with redirects disabled', async () => {
  prepare({ bytes: new Uint8Array(4), status: 200 });
  const artifact = { ...artifactFixture(), wasmBytes: 8 };
  await expect(loadCoreFactory({ artifact, baseUrl: 'https://naidan.invalid/nested/' })).rejects.toThrow('Truncated');
  expect(fetch).toHaveBeenCalledWith(new URL(artifact.wasmPath, 'https://naidan.invalid/nested/'), { credentials: 'same-origin', redirect: 'error' });
});

it('validates the loaded helper schema before any model context can be created', () => {
  const schemaSha256 = 'a'.repeat(64);
  const schema = { ...imageRuntimeSchemaFixture(), schemaSha256 };
  const helpers = { schema, attachCore: vi.fn(), mountReadOnlyFile: vi.fn() };
  expect(TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256 })).toBe(helpers);
  const generate = schema.functions.find(entry => entry.name === 'generate_image')!;
  generate.parameters.push({ kind: 'pointer', cType: 'int *' });
  expect(() => TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256 })).toThrow('incompatible upstream function: generate_image');
  expect(helpers.attachCore).not.toHaveBeenCalled();
  expect(helpers.mountReadOnlyFile).not.toHaveBeenCalled();
});

it('requires the helpers fingerprint and the new record contract independently', () => {
  const schemaSha256 = 'a'.repeat(64);
  const schema = { ...imageRuntimeSchemaFixture(), schemaSha256 };
  const helpers = { schema, attachCore: vi.fn(), mountReadOnlyFile: vi.fn() };
  expect(() => TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256: 'b'.repeat(64) })).toThrow('incompatible thin image core helpers');
  schema.records.find(entry => entry.name === 'sd_image_result_t')!.fields.find(field => field.name === 'image')!.kind = 'pointer';
  expect(() => TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256 })).toThrow('incompatible record field: sd_image_result_t.image');
});

it('binds an advertised BF16 feature to its verified helper schema without requiring it from old artifacts', () => {
  const schemaSha256 = 'a'.repeat(64), schema = { ...imageRuntimeSchemaFixture(), schemaSha256 };
  const helpers = { schema, attachCore: vi.fn(), mountReadOnlyFile: vi.fn() };
  expect(TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256, bf16WeightRetention: false })).toBe(helpers);
  expect(() => TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256, bf16WeightRetention: true })).toThrow('sd_browser_bf16_retention_version');
  schema.functions.push({ name: 'sd_browser_bf16_retention_version', returnType: 'uint32_t', returnKind: 'unsigned', parameters: [] });
  expect(TEST_ONLY.checkedCoreHelpers({ value: helpers, schemaSha256, bf16WeightRetention: true })).toBe(helpers);
});
