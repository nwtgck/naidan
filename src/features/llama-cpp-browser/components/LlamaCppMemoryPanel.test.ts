import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { observeWorkerMemory, TEST_ONLY } from '@/features/llama-cpp-browser/memory-diagnostics-store';
import LlamaCppMemoryPanel from './LlamaCppMemoryPanel.vue';

beforeEach(async () => {
  TEST_ONLY.reset();
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => vi.unstubAllGlobals());

describe('passive memory panel', () => {
  it('does not start workers when opened without samples', () => {
    const workerConstructor = vi.fn(); vi.stubGlobal('Worker', workerConstructor);
    const wrapper = mount(LlamaCppMemoryPanel);
    expect(wrapper.find('[data-testid="llama-memory-empty"]').exists()).toBe(true);
    expect(workerConstructor).not.toHaveBeenCalled(); wrapper.unmount();
  });

  it('shows earlier and ended samples as capacity rather than freed or used memory', () => {
    const worker = Object.assign(new EventTarget(), { postMessage() {} }); const stop = observeWorkerMemory({ worker });
    worker.dispatchEvent(new MessageEvent('message', {
      data: {
        kind: 'naidan-llama-cpp-memory',
        instanceId: 'historical-core',
        profile: 'cpu-wasm64',
        checkpoint: 'model-loaded',
        capacityBytes: 2 ** 33,
        timestamp: 1000,
      },
    }));
    stop();
    const wrapper = mount(LlamaCppMemoryPanel);
    expect(wrapper.text()).toContain('8192.00 MiB');
    expect(wrapper.text()).toContain('Ended');
    expect(wrapper.text()).toContain('not allocated heap usage');
    expect(wrapper.get('[data-testid="llama-memory-history"]').text()).toContain('model-loaded');
    wrapper.unmount();
  });
});

it('shows cumulative GPU requests and the matching load baseline without claiming live memory', () => {
  const worker = Object.assign(new EventTarget(), { postMessage() {} }); const stop = observeWorkerMemory({ worker });
  const baseline = { bufferCount: 2, bufferBytes: 1048576, writeCount: 1, writeBytes: 64, largestWriteBytes: 64, writesAtLeast4MiB: 0 };
  const latest = { bufferCount: 4, bufferBytes: 3145728, writeCount: 3, writeBytes: 1048640, largestWriteBytes: 1048576, writesAtLeast4MiB: 0 };
  for (const [checkpoint, gpuRequests] of [['before-model-load', baseline], ['model-loaded', latest]] as const) {
    worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'naidan-llama-cpp-memory', instanceId: 'gpu-core', profile: 'webgpu-wasm64-jspi', checkpoint, gpuRequests, capacityBytes: 65536, timestamp: 1000 } }));
  }
  const wrapper = mount(LlamaCppMemoryPanel);
  expect(wrapper.get('[data-testid="gpu-request-note"]').text()).toContain('not current memory usage');
  expect(wrapper.get('[data-testid="gpu-request-load-delta"]').text()).toContain('2.00 MiB');
  expect(wrapper.get('[data-testid="gpu-request-load-delta"]').text()).toContain('1.00 MiB');
  expect(wrapper.findAll('[data-testid="gpu-request-sample"]')).toHaveLength(2);
  expect(wrapper.findAll('[data-testid="gpu-request-sample"]')[0]!.text()).toContain('3.00 MiB');
  stop(); wrapper.unmount();
});
