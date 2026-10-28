// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQ8DiagnosticWorkerApi } from './q8-diagnostic-api';
import type { Q8KernelBenchmark } from '@/features/llama-cpp-browser/performance/q8-kernel-schema';

const fixture = vi.hoisted(() => ({
  asset: undefined as { relativePath: string, bytes: number, sha256: string } | undefined,
  fetchSchema: vi.fn(),
  loadRuntime: vi.fn(),
  createAdapter: vi.fn(),
  benchmark: vi.fn(),
  finish: vi.fn(),
  nativeFree: vi.fn(),
}));
vi.mock('virtual:llama-cpp-browser-core/availability', () => ({
  get q8KernelDiagnosticSchemaAsset() {
    return fixture.asset;
  },
}));
vi.mock('@/features/llama-cpp-browser/runtime/q8-diagnostic-assets', () => ({ loadQ8DiagnosticSchema: fixture.fetchSchema }));
vi.mock('@/features/llama-cpp-browser/runtime/load-runtime', () => ({ loadRuntime: fixture.loadRuntime }));
vi.mock('@/features/llama-cpp-browser/runtime/webgpu-request-diagnostics', () => ({ beginGpuMeasurement: () => fixture.finish, readGpuRequests: () => undefined }));
vi.mock('./q8-kernel-benchmark', () => ({ runQ8KernelBenchmark: fixture.benchmark }));

const request = { assetBaseURL: 'https://fixture.invalid/profiles/', schemaAssetSha256: 'a'.repeat(64) };
const schemaBytes = new TextEncoder().encode(JSON.stringify({ schemaSha256: 'b'.repeat(64) }));
const completed: Q8KernelBenchmark = { version: 1, fixtureId: 'q8-dyadic-v1', status: 'cancelled', repetitions: 32, rounds: 4, shapes: [] };

beforeEach(() => {
  vi.resetAllMocks();
  fixture.asset = { relativePath: 'webgpu-wasm64-jspi-gpu-profile/q8-diagnostic-v1.schema.json', bytes: schemaBytes.length, sha256: request.schemaAssetSha256 };
  fixture.fetchSchema.mockResolvedValue(schemaBytes);
  fixture.loadRuntime.mockResolvedValue({ createQ8KernelDiagnostic: fixture.createAdapter, api: { llama_backend_free: fixture.nativeFree } });
  fixture.createAdapter.mockResolvedValue({ run: vi.fn() });
  fixture.benchmark.mockResolvedValue(completed);
});

describe('one-shot Q8 diagnostic Worker API', () => {
  it('does not fetch or create a runtime for an older artifact', async () => {
    fixture.asset = undefined;
    const api = createQ8DiagnosticWorkerApi({ onProgress: () => {} });
    await expect(api.run({ request })).resolves.toEqual({ status: 'unavailable', reason: 'artifact' });
    expect(fixture.fetchSchema).not.toHaveBeenCalled();
    expect(fixture.loadRuntime).not.toHaveBeenCalled();
  });

  it('rejects an app/Worker asset identity mismatch before fetching', async () => {
    const api = createQ8DiagnosticWorkerApi({ onProgress: () => {} });
    await expect(api.run({ request: { ...request, schemaAssetSha256: 'c'.repeat(64) } })).rejects.toThrow('identity mismatch');
    expect(fixture.fetchSchema).not.toHaveBeenCalled();
    expect(fixture.loadRuntime).not.toHaveBeenCalled();
  });

  it('prepares the checked extension and returns separate asset and compiled identities', async () => {
    const onProgress = vi.fn();
    const api = createQ8DiagnosticWorkerApi({ onProgress });
    await expect(api.run({ request })).resolves.toMatchObject({ status: 'completed', schemaAssetSha256: 'a'.repeat(64), compiledSchemaSha256: 'b'.repeat(64), benchmark: completed });
    expect(fixture.createAdapter).toHaveBeenCalledExactlyOnceWith({ schemaBytes });
    expect(fixture.benchmark.mock.calls[0]![0]).toMatchObject({ signal: undefined, onProgress });
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.nativeFree).not.toHaveBeenCalled();
    await expect(api.run({ request })).rejects.toThrow('already been used');
  });

  it('does not invoke a benchmark when optional native exports are absent', async () => {
    fixture.createAdapter.mockResolvedValue(undefined);
    const api = createQ8DiagnosticWorkerApi({ onProgress: () => {} });
    await expect(api.run({ request })).resolves.toEqual({ status: 'unavailable', reason: 'native-exports' });
    expect(fixture.benchmark).not.toHaveBeenCalled();
    expect(fixture.finish).toHaveBeenCalledOnce();
  });

  it('rejects reentry during startup and does no individual native cleanup after a failure', async () => {
    const loading = Promise.withResolvers<never>();
    fixture.loadRuntime.mockReturnValue(loading.promise);
    const api = createQ8DiagnosticWorkerApi({ onProgress: () => {} });
    const first = api.run({ request });
    const failed = expect(first).rejects.toThrow('native startup trap');
    await expect(api.run({ request })).rejects.toThrow('already been used');
    loading.reject(new Error('native startup trap'));
    await failed;
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.nativeFree).not.toHaveBeenCalled();
  });

  it('propagates benchmark failure for whole-Worker retirement without native cleanup', async () => {
    fixture.benchmark.mockRejectedValue(new Error('poisoned native call'));
    const api = createQ8DiagnosticWorkerApi({ onProgress: () => {} });
    await expect(api.run({ request })).rejects.toThrow('poisoned native call');
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.nativeFree).not.toHaveBeenCalled();
  });
});
