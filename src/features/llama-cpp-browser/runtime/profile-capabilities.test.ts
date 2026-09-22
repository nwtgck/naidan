import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeRuntimeProfiles } from './detect-profile';
import { profileCapabilitiesSchema } from './profile-capabilities';
import { checkJspi, checkStorage, gpuUnavailableReason, supportsMemory64 } from './capability-probes';
vi.mock('./capability-probes', () => ({ checkJspi: vi.fn(), checkStorage: vi.fn(), gpuUnavailableReason: vi.fn(), supportsMemory64: vi.fn() }));
// Hosted capability inspection must never acquire the standalone Brotli dependency.
vi.mock('@/features/file-protocol-standalone/embedded-binary', () => {
  throw new Error('Hosted probes must not import Brotli');
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkJspi).mockResolvedValue(undefined); vi.mocked(checkStorage).mockResolvedValue(undefined);
  vi.mocked(gpuUnavailableReason).mockResolvedValue(undefined); vi.mocked(supportsMemory64).mockReturnValue(true);
});
describe('hosted runtime capability report', () => {
  it.each([
    { memory64: true, jspi: true, gpu: true, expected: 'webgpu-wasm64-jspi' },
    { memory64: false, jspi: true, gpu: true, expected: 'webgpu-wasm32-jspi' },
    { memory64: false, jspi: false, gpu: true, expected: 'webgpu-wasm32-asyncify' },
    { memory64: true, jspi: false, gpu: false, expected: 'cpu-wasm64' },
    { memory64: false, jspi: false, gpu: false, expected: 'cpu-wasm32' },
  ])('recommends $expected using actual feature results', async ({ memory64, jspi, gpu, expected }) => {
    vi.mocked(supportsMemory64).mockReturnValue(memory64);
    if (!jspi) vi.mocked(checkJspi).mockRejectedValue(new Error('unavailable'));
    if (!gpu) vi.mocked(gpuUnavailableReason).mockResolvedValue('webgpu');
    const report = await probeRuntimeProfiles();
    expect(report.recommended).toBe(expected); expect(report.profiles).toHaveLength(5);
    expect(checkStorage).toHaveBeenCalledOnce();
  });
  it('reports storage failure independently from file-management state', async () => {
    vi.mocked(checkStorage).mockRejectedValue(new Error('private detail'));
    const report = await probeRuntimeProfiles();
    expect(report.recommended).toBeUndefined();
    expect(report.profiles.every(entry => entry.status === 'unavailable' && entry.reason === 'storage')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('private detail');
  });
  it('rejects inconsistent or duplicate RPC reports', () => {
    expect(profileCapabilitiesSchema.safeParse({ recommended: 'cpu-wasm32', profiles: [] }).success).toBe(false);
    expect(profileCapabilitiesSchema.safeParse({ profiles: [{ profile: 'cpu-wasm32', status: 'available' }, { profile: 'cpu-wasm32', status: 'available' }] }).success).toBe(false);
    expect(profileCapabilitiesSchema.safeParse({ profiles: [{ profile: 'cpu-wasm32', status: 'unavailable', reason: 'private error' }] }).success).toBe(false);
  });
});
