import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeRuntimeProfiles } from './detect-profile';
import { profileCapabilitiesSchema } from './profile-capabilities';
import { checkJspi, checkStorage, probeGpuCapabilities, supportsMemory64 } from './capability-probes';
const artifact = vi.hoisted(() => ({ available: true }));
vi.mock('virtual:llama-cpp-browser-core/availability', () => ({
  get gpuProfilingAvailable() {
    return artifact.available;
  },
}));
vi.mock('./capability-probes', () => ({ checkJspi: vi.fn(), checkStorage: vi.fn(), probeGpuCapabilities: vi.fn(), supportsMemory64: vi.fn() }));
// Hosted capability inspection must never acquire the standalone Brotli dependency.
vi.mock('@/features/file-protocol-standalone/embedded-binary', () => {
  throw new Error('Hosted probes must not import Brotli');
});

beforeEach(() => {
  vi.resetAllMocks();
  artifact.available = true;
  vi.mocked(checkJspi).mockResolvedValue(undefined);
  vi.mocked(checkStorage).mockResolvedValue(undefined);
  vi.mocked(probeGpuCapabilities).mockResolvedValue({ timestampQuery: true });
  vi.mocked(supportsMemory64).mockReturnValue(true);
});

describe('hosted runtime capability report', () => {
  it.each([
    { memory64: true, jspi: true, gpu: true, expected: 'webgpu-wasm64-jspi' },
    { memory64: false, jspi: true, gpu: true, expected: 'webgpu-wasm32-jspi' },
    { memory64: false, jspi: false, gpu: true, expected: 'webgpu-wasm32-asyncify' },
    { memory64: true, jspi: false, gpu: false, expected: 'cpu-wasm32' },
    { memory64: false, jspi: false, gpu: false, expected: 'cpu-wasm32' },
  ])('recommends $expected using actual feature results', async ({ memory64, jspi, gpu, expected }) => {
    vi.mocked(supportsMemory64).mockReturnValue(memory64);
    if (!jspi) {
      vi.mocked(checkJspi).mockRejectedValue(new Error('unavailable'));
    }
    if (!gpu) {
      vi.mocked(probeGpuCapabilities).mockResolvedValue({ reason: 'webgpu', timestampQuery: false });
    }
    const report = await probeRuntimeProfiles();
    expect(report.recommended).toBe(expected);
    expect(report.profiles).toHaveLength(5);
    expect(checkStorage).toHaveBeenCalledOnce();
  });

  it('requires timestamp-query only for the diagnostic runtime and never recommends it for chat', async () => {
    vi.mocked(probeGpuCapabilities).mockResolvedValue({ timestampQuery: false });
    const report = await probeRuntimeProfiles();
    expect(report.recommended).toBe('webgpu-wasm64-jspi');
    expect(report.profiles.find(entry => entry.profile === 'webgpu-wasm64-jspi')).toEqual({ profile: 'webgpu-wasm64-jspi', status: 'available' });
    expect(report.profiles.find(entry => entry.profile === 'webgpu-wasm64-jspi-gpu-profile')).toMatchObject({ status: 'unavailable', reason: 'timestamp-query' });
    expect(profileCapabilitiesSchema.safeParse({ ...report, recommended: 'webgpu-wasm64-jspi-gpu-profile' }).success).toBe(false);
  });

  it('distinguishes an unpublished diagnostic artifact from device capability failure', async () => {
    artifact.available = false;
    const report = await probeRuntimeProfiles();
    expect(report.profiles.find(entry => entry.profile === 'webgpu-wasm64-jspi-gpu-profile')).toMatchObject({ status: 'unavailable', reason: 'profiling-artifact' });
    expect(report.recommended).toBe('webgpu-wasm64-jspi');
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
