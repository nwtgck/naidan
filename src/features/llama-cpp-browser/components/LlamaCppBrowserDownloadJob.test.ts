import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';

enableAutoUnmount(afterEach);
const cancel = vi.hoisted(() => vi.fn());
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', () => ({
  getDownloadQueue: () => ({ cancel, position: () => undefined }),
}));

beforeEach(async () => {
  cancel.mockReset();
  await ensureAllStringsForTest({ locale: 'en' });
});

it('retains progress while paused, stops time estimates, and exposes resume without restarting by itself', async () => {
  const job: DownloadJob = {
    id: 1,
    key: 'model',
    repository: 'owner/model',
    source: 'repository',
    destination: { kind: 'opfs' },
    status: 'downloading',
    selection: undefined,
    error: undefined,
    progress: { phase: 'transferring', processed: 1024, completed: 1024, total: 2048 },
  };
  const wrapper = mount(LlamaCppBrowserDownloadJob, { props: { job, disabled: false, appearance: 'welcome', sourcesVisibility: 'hidden' } });
  expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
  await wrapper.get('[data-testid="llama-download-pause"]').trigger('click');
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: 1 });
  await wrapper.setProps({ job: { ...job, status: 'paused' } });
  expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
  expect(wrapper.find('[data-testid="llama-hf-remaining"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="llama-download-speed"]').exists()).toBe(false);
  expect(wrapper.emitted('resume')).toBeUndefined();
  await wrapper.setProps({ disabled: true });
  await wrapper.get('[data-testid="llama-download-resume"]').trigger('click');
  expect(wrapper.emitted('resume')).toBeUndefined();
  await wrapper.setProps({ disabled: false });
  await wrapper.get('[data-testid="llama-download-resume"]').trigger('click');
  expect(wrapper.emitted('resume')).toHaveLength(1);
});
