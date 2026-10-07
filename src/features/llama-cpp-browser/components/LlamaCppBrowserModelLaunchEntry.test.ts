import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { DEFAULT_SETTINGS } from '@/01-models/types';
import { modelLaunchEntryState, modelLaunchRetry, TEST_ONLY } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { modelLaunchPresentation } from '@/features/llama-cpp-browser/model-launch/presentation';
import LlamaCppBrowserModelLaunchEntry from './LlamaCppBrowserModelLaunchEntry.vue';
const settings = ref({ ...DEFAULT_SETTINGS, storageType: 'memory' });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/features/file-protocol-standalone/composables/usePortableAppDownload', () => ({ usePortableAppDownload: () => ({}) }));

beforeEach(async () => {
  TEST_ONLY.reset(); await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => TEST_ONLY.reset());

describe('immediate model link presentation', () => {
  it('shows the model and requested variant while app initialization and metadata are still pending', async () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M' } });
    expect(wrapper.get('h2').text()).toBe('LFM2.5-230M-GGUF');
    expect(wrapper.text()).toContain('LiquidAI');
    expect(wrapper.get('[data-testid="model-launch-requested-variant"]').text()).toBe('Q4_K_M');
    expect(wrapper.get('[role="status"]').text()).toContain('Hugging Face');
    expect(wrapper.text()).not.toContain('GiB');
    expect(wrapper.find('[data-testid="model-launch-download"]').exists()).toBe(false);
    modelLaunchEntryState.value = { status: 'checking', input: 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M', phase: 'opening-chat' };
    await flushPromises(); expect(wrapper.get('[role="status"]').text()).toBe('Opening your chat…');
    expect(wrapper.get('h2').text()).toBe('LFM2.5-230M-GGUF'); wrapper.unmount();
  });

  it('preserves the same model heading on network failure and retries in place', async () => {
    const input = 'owner/Model-GGUF';
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input } });
    modelLaunchEntryState.value = { status: 'failed', input, problem: 'failed' }; await flushPromises();
    expect(wrapper.get('h2').text()).toBe('Model-GGUF');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await wrapper.get('[data-testid="model-launch-retry"]').trigger('click');
    expect(modelLaunchRetry.value).toBe(1); wrapper.unmount();
  });

  it('does not fabricate a variant or size when the link has no selector', () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: 'owner/Model-GGUF' } });
    expect(wrapper.find('[data-testid="model-launch-requested-variant"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('GiB'); wrapper.unmount();
  });

  it.each([null, undefined, ['owner/repo', 'owner/other'], '', 'https://external.example/owner/repo', 'x'.repeat(4097), 'https://user:password@huggingface.co/owner/repo'])('rejects untrusted display input %s', input => {
    expect(modelLaunchPresentation({ input })).toBeUndefined();
  });

  it('renders remote-looking selector text as text, not HTML', () => {
    const wrapper = mount(LlamaCppBrowserModelLaunchEntry, { props: { input: 'owner/repo:<img src=x onerror=alert(1)>' } });
    expect(wrapper.find('img').exists()).toBe(false); wrapper.unmount();
  });
});
