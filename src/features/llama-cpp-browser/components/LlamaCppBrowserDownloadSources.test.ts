import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { lazyStrings } from '@/strings';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { modelDownloadUrl } from '@/features/llama-cpp-browser/hugging-face/download-url';
import LlamaCppBrowserDownloadSources from './LlamaCppBrowserDownloadSources.vue';
const copy = vi.fn();
const source: DownloadJob = {
  id: 1,
  key: 'fixture',
  repository: 'owner/repo',
  source: 'repository',
  destination: { kind: 'opfs' },
  status: 'downloading',
  error: undefined,
  selection: { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'dir/model-00001-of-00002.gguf', size: 128 }, { path: 'dir/model-00002-of-00002.gguf', size: 128 }] },
  progress: { phase: 'transferring', completed: 128, total: 256, processed: 0, currentFileIndex: 1 },
};

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
});

describe('download source disclosure', () => {
  it('mounts the URL list only after explicit expansion and shows the actual request index, not inferred bytes', async () => {
    const wrapper = mount(LlamaCppBrowserDownloadSources, { props: { job: source } });
    expect(wrapper.find('details').exists()).toBe(false);
    const toggle = wrapper.get('button'); expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.findAll('[data-testid="model-download-url"]')).toHaveLength(0);
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-testid="model-download-sources-panel"]').attributes('id')).toBe(toggle.attributes('aria-controls'));
    expect(wrapper.findAll('[data-testid="model-download-url"]').map(node => node.text())).toEqual(source.selection!.files.map(file => modelDownloadUrl({ ...source.selection!, file })));
    expect(wrapper.get('[data-current="true"]').text()).toContain('00002');
    expect(wrapper.get('[data-testid="model-download-sources-help"]').text()).toBe(lazyStrings.LlamaCppBrowserDownloadSources__request_urls_help());
    expect(copy).not.toHaveBeenCalled();
    await wrapper.setProps({ job: { ...source, status: 'paused' } });
    expect(wrapper.find('[data-current="true"]').exists()).toBe(false); wrapper.unmount();
  });

  it('copies only the requested URL and reports failure without claiming success', async () => {
    const wrapper = mount(LlamaCppBrowserDownloadSources, { props: { job: source } });
    await wrapper.get('button').trigger('click'); await wrapper.findAll('[data-testid="model-download-copy"]')[1]!.trigger('click');
    await flushPromises(); expect(copy).toHaveBeenCalledWith(modelDownloadUrl({ ...source.selection!, file: source.selection!.files[1]! }));
    expect(wrapper.get('[role="status"]').text()).toBe('URL copied.');
    copy.mockRejectedValueOnce(new Error('permission denied'));
    await wrapper.findAll('[data-testid="model-download-copy"]')[0]!.trigger('click'); await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain('Could not copy'); wrapper.unmount();
  });

  it('closes with Escape and returns focus to its own control', async () => {
    const wrapper = mount(LlamaCppBrowserDownloadSources, { props: { job: source }, attachTo: document.body });
    const toggle = wrapper.get('[data-testid="model-download-sources-toggle"]'); await toggle.trigger('click');
    await wrapper.get('[data-testid="model-download-sources-panel"]').trigger('keydown', { key: 'Escape' });
    expect(toggle.attributes('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(toggle.element);
    expect(wrapper.find('[data-testid="model-download-copy"]').exists()).toBe(false); wrapper.unmount();
  });

  it('keeps disclosure and copy state through progress ticks, resets on a new plan, and ignores late clipboard replies', async () => {
    const gate = Promise.withResolvers<void>(); copy.mockReturnValueOnce(gate.promise);
    const wrapper = mount(LlamaCppBrowserDownloadSources, { props: { job: source } });
    await wrapper.get('button').trigger('click'); await wrapper.findAll('[data-testid="model-download-copy"]')[0]!.trigger('click');
    await wrapper.setProps({ job: { ...source, progress: { ...source.progress!, completed: 160 } } });
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('true');
    await wrapper.setProps({ job: { ...source, id: 2 } });
    expect(wrapper.get('button').attributes('aria-expanded')).toBe('false'); gate.resolve(); await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false); wrapper.unmount();
  });

  it('does not show invalid source data or an out-of-range current file', async () => {
    const wrapper = mount(LlamaCppBrowserDownloadSources, { props: { job: { ...source, selection: undefined } } });
    expect(wrapper.find('button').exists()).toBe(false);
    await wrapper.setProps({ job: { ...source, selection: { ...source.selection!, revision: 'main' } } });
    expect(wrapper.find('button').exists()).toBe(false);
    await wrapper.setProps({ job: { ...source, progress: { ...source.progress!, currentFileIndex: 99 } } });
    await wrapper.get('button').trigger('click'); expect(wrapper.find('[data-current="true"]').exists()).toBe(false); wrapper.unmount();
  });
});
