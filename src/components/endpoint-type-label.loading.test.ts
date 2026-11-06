import { expect, it } from 'vitest';
import { registerStringBoundary, TEST_ONLY as runtimeTestOnly, type StringBoundaryModule } from '@/strings/runtime';
import { endpointTypeLabel, ensureEndpointTypeLabel } from './endpoint-type-label';

it('waits for an unloaded label instead of freezing undefined into a profile name', async () => {
  runtimeTestOnly.reset();
  const { promise, resolve } = Promise.withResolvers<StringBoundaryModule>();
  const load = () => promise;
  const boundary = registerStringBoundary({
    boundaryId: 'endpoint-label-loading',
    keys: ['llamaCppBrowser__endpoint_label'],
    loaders: { en: load, ja: load, 'zh-Hans': load, 'pt-BR': load, es: load, ko: load, de: load },
  });
  using _cleanup = {
    [Symbol.dispose]() {
      boundary.unregister();
    },
  };
  expect(endpointTypeLabel({ endpointType: 'llama_cpp_browser' })).toBeUndefined();
  let settled = false;
  const name = ensureEndpointTypeLabel({ endpointType: 'llama_cpp_browser' }).then(label => {
    settled = true;
    return label;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  resolve({ llamaCppBrowser__endpoint_label: () => 'llama.cpp in the browser' });
  await expect(name).resolves.toBe('llama.cpp in the browser');
  expect(endpointTypeLabel({ endpointType: 'llama_cpp_browser' })).toBe('llama.cpp in the browser');
});
