import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRuntimeProfile } from './detect-profile';

function browser({ memory64, jspi, adapter }: { memory64: boolean, jspi: boolean, adapter: 'ready' | 'missing' | 'no-f16' | 'error' }) {
  const validate = vi.fn(() => memory64);
  vi.stubGlobal('WebAssembly', { validate, ...(jspi ? { promising: () => {}, Suspending: () => {} } : {}) });
  const requestAdapter = vi.fn(async () => {
    if (adapter === 'error') throw new Error('private adapter failure');
    if (adapter === 'missing') return undefined;
    return { features: new Set(adapter === 'ready' ? ['shader-f16'] : []) };
  });
  vi.stubGlobal('navigator', { gpu: { requestAdapter }, get userAgent() {
    throw new Error('Profile selection must use feature detection');
  } });
  return { requestAdapter, validate };
}
afterEach(() => vi.unstubAllGlobals());
describe('automatic browser inference profile', () => {
  it('prefers WebGPU wasm64 when memory64, JSPI and the required adapter feature are present', async () => {
    const { requestAdapter, validate } = browser({ memory64: true, jspi: true, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('webgpu-wasm64-jspi');
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]).toBeDefined();
  });
  it.each([{ memory64: false, jspi: false }, { memory64: true, jspi: false }])('uses WebGPU Asyncify with memory64=$memory64 and JSPI=$jspi', async ({ memory64, jspi }) => {
    const { requestAdapter } = browser({ memory64, jspi, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('webgpu-wasm32-asyncify');
    expect(requestAdapter).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'no-f16', 'error'] as const)('uses CPU when the adapter is %s without exposing its error', async (adapter) => {
    browser({ memory64: true, jspi: true, adapter });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm64');
  });
  it.each(['missing', 'no-f16', 'error'] as const)('uses CPU wasm32 when the adapter is %s and memory64 is unavailable', async (adapter) => {
    browser({ memory64: false, jspi: false, adapter });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm32');
  });
  it('honors all explicit selections without probing or silently falling back', async () => {
    const { requestAdapter, validate } = browser({ memory64: false, jspi: false, adapter: 'missing' });
    for (const profile of ['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify'] as const) {
      expect(await resolveRuntimeProfile({ profile })).toBe(profile);
    }
    expect(validate).not.toHaveBeenCalled(); expect(requestAdapter).not.toHaveBeenCalled();
  });
  it('selects WebGPU wasm32 JSPI when JSPI is available without memory64', async () => {
    browser({ memory64: false, jspi: true, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('webgpu-wasm32-jspi');
  });
  it('keeps an explicit wasm32 JSPI selection when memory64 is also available', async () => {
    const { requestAdapter, validate } = browser({ memory64: true, jspi: true, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'webgpu-wasm32-jspi' })).toBe('webgpu-wasm32-jspi');
    expect(validate).not.toHaveBeenCalled(); expect(requestAdapter).not.toHaveBeenCalled();
  });
  it('handles engines that throw while validating memory64', async () => {
    const { validate } = browser({ memory64: false, jspi: true, adapter: 'ready' });
    validate.mockImplementation(() => {
      throw new Error('unsupported proposal');
    });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('webgpu-wasm32-jspi');
  });
  it('uses CPU wasm64 when there is no GPU API', async () => {
    browser({ memory64: true, jspi: true, adapter: 'missing' }); vi.stubGlobal('navigator', {});
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm64');
  });
});
