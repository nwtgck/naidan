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
  vi.stubGlobal('navigator', { gpu: { requestAdapter } });
  return { requestAdapter, validate };
}
afterEach(() => vi.unstubAllGlobals());
describe('automatic browser inference profile', () => {
  it('selects WebGPU only when memory64, JSPI and the required adapter feature are present', async () => {
    const { requestAdapter, validate } = browser({ memory64: true, jspi: true, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('webgpu-wasm64-jspi');
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(validate.mock.calls[0]).toBeDefined();
  });
  it('uses CPU wasm32 without requesting an adapter when memory64 is unavailable', async () => {
    const { requestAdapter } = browser({ memory64: false, jspi: true, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm32');
    expect(requestAdapter).not.toHaveBeenCalled();
  });
  it('uses CPU wasm64 when JSPI is unavailable', async () => {
    const { requestAdapter } = browser({ memory64: true, jspi: false, adapter: 'ready' });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm64');
    expect(requestAdapter).not.toHaveBeenCalled();
  });
  it.each(['missing', 'no-f16', 'error'] as const)('uses CPU when the adapter is %s without exposing its error', async (adapter) => {
    browser({ memory64: true, jspi: true, adapter });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm64');
  });
  it('honors all explicit selections without probing or silently falling back', async () => {
    const { requestAdapter, validate } = browser({ memory64: false, jspi: false, adapter: 'missing' });
    for (const profile of ['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm64-jspi'] as const) {
      expect(await resolveRuntimeProfile({ profile })).toBe(profile);
    }
    expect(validate).not.toHaveBeenCalled(); expect(requestAdapter).not.toHaveBeenCalled();
  });
  it('handles engines that throw while validating memory64', async () => {
    const { validate } = browser({ memory64: false, jspi: true, adapter: 'ready' });
    validate.mockImplementation(() => {
      throw new Error('unsupported proposal');
    });
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm32');
  });
  it('uses CPU wasm64 when there is no GPU API', async () => {
    browser({ memory64: true, jspi: true, adapter: 'missing' }); vi.stubGlobal('navigator', {});
    expect(await resolveRuntimeProfile({ profile: 'auto' })).toBe('cpu-wasm64');
  });
});
