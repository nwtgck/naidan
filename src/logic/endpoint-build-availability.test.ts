import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEndpointBuildAvailability } from './endpoint-build-availability';

afterEach(() => vi.unstubAllGlobals());
describe('endpoint distribution policy', () => {
  it.each([false, true])('keeps installed endpoint choices available with standalone=%s', standalone => {
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', standalone);
    for (const type of ['openai', 'ollama', 'llama_cpp_browser', 'browser_provided_lm'] as const) {
      expect(getEndpointBuildAvailability({ type })).toBe('available');
    }
    expect(getEndpointBuildAvailability({ type: 'transformers_js' })).toBe(standalone ? 'unavailable-in-standalone' : 'available');
  });
});
