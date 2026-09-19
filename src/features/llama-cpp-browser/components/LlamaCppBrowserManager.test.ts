import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import LlamaCppBrowserManager from './LlamaCppBrowserManager.vue';
import type { EngineState } from '@/features/llama-cpp-browser/types';
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: {
  getState: vi.fn<() => EngineState>(() => ({ status: 'unavailable' })),
  getOptions: () => ({ profile: 'webgpu-wasm64-jspi', contextSize: 4096 }),
  subscribe: vi.fn(({ listener }) => {
    listener({ state: { status: 'unavailable' } }); return () => {};
  }),
  listModels: vi.fn(async () => []), setOptions: vi.fn(), importModel: vi.fn(), removeModel: vi.fn(),
  release: vi.fn(), cancel: vi.fn(),
} }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn(async () => true) }) }));
beforeEach(async () => {
  vi.clearAllMocks(); await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => vi.restoreAllMocks());
describe('standalone-visible local model manager', () => {
  it('renders the feature and its controls but disables them without reading OPFS', async () => {
    const wrapper = mount(LlamaCppBrowserManager);
    await flushPromises();
    expect(wrapper.get('[data-testid="llama-cpp-browser-unavailable"]').text()).toContain('standalone');
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="llama-cpp-browser-profile"]').exists()).toBe(true);
    expect(llamaCppBrowserService.listModels).not.toHaveBeenCalled();
    expect(llamaCppBrowserService.importModel).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
