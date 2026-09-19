import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import type { EngineState } from '@/features/llama-cpp-browser/types';
import LlamaCppBrowserLoadingIndicator from './LlamaCppBrowserLoadingIndicator.vue';
const listeners = vi.hoisted(() => new Set<(event: { state: EngineState }) => void>());
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: {
  getState: vi.fn<() => EngineState>(() => ({ status: 'idle' })),
  subscribe: vi.fn(({ listener }: { listener: (event: { state: EngineState }) => void }) => {
    listeners.add(listener); return () => {
      listeners.delete(listener);
    };
  }),
} }));
beforeEach(async () => {
  vi.clearAllMocks(); listeners.clear(); await ensureAllStringsForTest({ locale: 'en' });
});
describe('scoped inline loading status', () => {
  it.each<EngineState>([{ status: 'idle' }, { status: 'unavailable' }, { status: 'error', code: 'runtime-error' },
    { status: 'working', progress: { phase: 'generating', completed: 15, total: 100 } }])('renders no persistent label or bar for $status', state => {
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue(state);
    const wrapper = mount(LlamaCppBrowserLoadingIndicator, { props: { scope: 'inference' } });
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('progress').exists()).toBe(false); wrapper.unmount();
  });
  it('shows bounded preparation progress and removes itself on completion', async () => {
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'working', progress: { phase: 'loading', completed: 150, total: 100 } });
    const wrapper = mount(LlamaCppBrowserLoadingIndicator, { props: { scope: 'inference' } });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100');
    expect(wrapper.text()).toContain('100%');
    expect(wrapper.find('progress').exists()).toBe(false);
    for (const listener of listeners) listener({ state: { status: 'idle' } });
    await flushPromises(); expect(wrapper.find('[role="status"]').exists()).toBe(false);
    wrapper.unmount(); expect(listeners.size).toBe(0);
  });
  it('keeps import status out of chat and inference status out of the import panel', async () => {
    vi.mocked(llamaCppBrowserService.getState).mockReturnValue({ status: 'working', progress: { phase: 'importing', completed: 1, total: 2 } });
    const chat = mount(LlamaCppBrowserLoadingIndicator, { props: { scope: 'inference' } });
    const importer = mount(LlamaCppBrowserLoadingIndicator, { props: { scope: 'import' } });
    expect(chat.find('[role="status"]').exists()).toBe(false);
    expect(importer.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
    for (const listener of listeners) listener({ state: { status: 'working', progress: { phase: 'initializing', completed: 0, total: 0 } } });
    await flushPromises();
    expect(chat.get('[role="status"]').text()).not.toBe('');
    expect(chat.find('[role="progressbar"]').exists()).toBe(false);
    expect(importer.find('[role="status"]').exists()).toBe(false);
    chat.unmount(); importer.unmount();
  });
});
