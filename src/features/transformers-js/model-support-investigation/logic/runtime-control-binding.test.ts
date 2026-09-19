import { expect, it, vi } from 'vitest';
import { resolveHostedTransformersRuntimeAssetUrls } from '@/features/transformers-js/runtime/configure-hosted-runtime';
import { runtimeControlBindingSchema, withVerifiedRuntimeControl } from './runtime-control-binding';

const assets = resolveHostedTransformersRuntimeAssetUrls({
  workerLocationUrl: 'https://naidan.example/assets/worker.js', environment: 'production',
  userAgent: 'AppleWebKit Safari', vendor: '',
});
const bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const verifiedWasm = { bytes, sha256: 'a'.repeat(64) };

it('supplies the same verified buffer, retains only scalar evidence, and restores the prior environment', async () => {
  const previous = Uint8Array.of(9);
  const environment = { wasmPaths: { mjs: assets.mjsUrl, wasm: assets.wasmUrl }, wasmBinary: previous };
  const observed = vi.fn();
  const supplied: unknown[] = [];
  const result = await withVerifiedRuntimeControl({
    executionProvider: 'wasm', assets, configuredEnvironment: environment, controlEnvironment: environment,
    verifiedWasm, observeBinding: observed,
    run: async () => {
      supplied.push(environment.wasmBinary); return 7;
    },
  });
  expect(result).toBe(7);
  expect(supplied).toEqual([bytes]);
  expect(supplied[0]).toBe(bytes);
  expect(environment.wasmBinary).toBe(previous);
  expect(observed.mock.calls[0]?.[0].observation).toEqual({
    format: 'runtime-control-binding-v1', executionProvider: 'wasm',
    constructorModule: 'onnxruntime-web/webgpu', environmentMatchesConfigured: true,
    mjs: { matchesSelected: true, byteConnection: 'configured-url-not-verified-import-bytes' },
    wasm: {
      matchesSelected: true,
      supplySource: 'preflight-verified-buffer', suppliedByteLength: 8,
      suppliedSha256: 'a'.repeat(64), suppliedMagicHex: '0061736d01000000', compilerConsumption: 'not-observed',
    },
  });
  expect(JSON.stringify(observed.mock.calls)).not.toContain('wasmBinary');
});

it.each([
  { observation: 'throw', observeBinding: () => {
    throw new Error('observer rejection');
  } },
  { observation: 'reject', observeBinding: () => Promise.reject(new Error('asynchronous observer rejection')) },
  { observation: 'pending', observeBinding: () => Promise.withResolvers<void>().promise },
].flatMap(testCase => [false, true].map(rejected => ({ ...testCase, rejected }))))('does not let observation $observation replace native settlement: rejected=$rejected', async ({ observeBinding, rejected }) => {
  const nativeError = new Error('native control rejection');
  const environment = { wasmPaths: { mjs: assets.mjsUrl, wasm: assets.wasmUrl }, wasmBinary: undefined as Uint8Array | undefined };
  const run = vi.fn(async () => {
    if (rejected) throw nativeError; return 7;
  });
  const result = await withVerifiedRuntimeControl({
    executionProvider: 'webgpu', assets, configuredEnvironment: environment, controlEnvironment: environment,
    verifiedWasm, observeBinding, run,
  }).then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
  expect(result).toEqual(rejected ? { status: 'rejected', error: nativeError } : { status: 'fulfilled', value: 7 });
  expect(run).toHaveBeenCalledOnce();
  expect(environment.wasmBinary).toBeUndefined();
});

it('records a mismatch without exporting unknown runtime URLs or changing the native result', async () => {
  const observed = vi.fn();
  const result = await withVerifiedRuntimeControl({
    executionProvider: 'wasm', assets, configuredEnvironment: {},
    controlEnvironment: { wasmPaths: { mjs: 'https://private.invalid/module?token=secret', wasm: 'https://private.invalid/body' } },
    verifiedWasm, observeBinding: observed, run: async () => 7,
  });
  expect(result).toBe(7);
  expect(observed.mock.calls[0]?.[0].observation).toMatchObject({
    environmentMatchesConfigured: false,
    mjs: { matchesSelected: false },
    wasm: { matchesSelected: false },
  });
  expect(JSON.stringify(observed.mock.calls)).not.toMatch(/private|secret/u);
});

it('does not silently refetch when verified bytes are unavailable', async () => {
  const run = vi.fn(async () => 7);
  await expect(withVerifiedRuntimeControl({
    executionProvider: 'wasm', assets, configuredEnvironment: {}, controlEnvironment: {},
    verifiedWasm: undefined, observeBinding: vi.fn(), run,
  })).rejects.toThrow('Verified runtime WASM bytes are unavailable');
  expect(run).not.toHaveBeenCalled();
});

it('rejects unbounded extra diagnostic fields', () => {
  expect(runtimeControlBindingSchema.safeParse({ arbitraryError: 'private' }).success).toBe(false);
});
