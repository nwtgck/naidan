import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserDownloadJob from './LlamaCppBrowserDownloadJob.vue';
import HuggingFaceDownloadFailureHint from '@/components/HuggingFaceDownloadFailureHint.vue';

enableAutoUnmount(afterEach);
const cancel = vi.hoisted(() => vi.fn());
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', () => ({
  getDownloadQueue: () => ({ cancel, position: () => undefined }),
}));
vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: { props: ['target', 'presentation'], template: '<aside data-testid="download-csp-message" :data-presentation="presentation" />' },
}));
vi.mock('./LlamaCppBrowserLocalFileRecovery.vue', () => ({
  default: { name: 'LlamaCppBrowserLocalFileRecovery', props: ['disabled', 'acceptLocalInput'], template: '<aside data-testid="download-file-recovery" />' },
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
  const wrapper = mount(LlamaCppBrowserDownloadJob, { props: { job, acceptLocalInput: undefined, disabled: false, appearance: 'welcome', sourcesVisibility: 'hidden' } });
  expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('50');
  await wrapper.get('[data-testid="llama-download-pause"]').trigger('click');
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ id: 1 });
  await wrapper.setProps({ job: { ...job, status: 'paused' } });
  expect(wrapper.get('[data-testid="download-csp-message"]').attributes('data-presentation')).toBe('compact');
  expect(wrapper.find('[data-testid="download-file-recovery"]').exists()).toBe(false);
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

it.each(['welcome', 'manager'] as const)('keeps the %s failure supplement outside hidden sources without changing retry', async appearance => {
  const job: DownloadJob = { id: 2, key: 'model', repository: 'owner/model', source: 'repository', destination: { kind: 'opfs' }, status: 'failed', selection: undefined, error: 'failed', progress: undefined };
  const wrapper = mount(LlamaCppBrowserDownloadJob, { props: { job, acceptLocalInput: undefined, disabled: false, appearance, density: 'compact', sourcesVisibility: 'hidden' } });
  expect(wrapper.find('[data-testid="download-file-recovery"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="download-csp-message"]').exists()).toBe(false);
  await wrapper.getComponent(HuggingFaceDownloadFailureHint).get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  expect(wrapper.find('[data-testid="download-file-recovery"]').exists()).toBe(true);
  expect(wrapper.getComponent({ name: 'LlamaCppBrowserLocalFileRecovery' }).props('acceptLocalInput')).toBeUndefined();
  expect(wrapper.find('[data-testid="llama-download-sources"]').exists()).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-download-resume"]').element.disabled).toBe(false);
  await wrapper.get('[data-testid="llama-download-resume"]').trigger('click');
  expect(wrapper.emitted('resume')).toHaveLength(1);
  expect(cancel).not.toHaveBeenCalled();
  await wrapper.setProps({ job: { ...job, error: 'projector-conflict' } });
  expect(wrapper.find('[data-testid="download-file-recovery"]').exists()).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-download-resume"]').element.disabled).toBe(false);
  await wrapper.setProps({ job: { ...job, status: 'paused', error: undefined } });
  expect(wrapper.findComponent(HuggingFaceDownloadFailureHint).exists()).toBe(false);
  expect(wrapper.get('[data-testid="download-csp-message"]').attributes('data-presentation')).toBe('compact');
  await wrapper.setProps({ job: { ...job, status: 'complete', error: undefined } });
  expect(wrapper.findComponent(HuggingFaceDownloadFailureHint).exists()).toBe(false);
  expect(wrapper.find('[data-testid="download-csp-message"]').exists()).toBe(false);
});

it.each(['regular', 'compact'] as const)('preserves the explicit local-input owner in the %s failure view', async density => {
  const job: DownloadJob = { id: 3, key: 'owned-model', repository: 'owner/model', source: 'repository', destination: { kind: 'opfs' }, status: 'failed', selection: undefined, error: 'selection-unavailable', progress: undefined };
  const acceptLocalInput = vi.fn(async () => {});
  const wrapper = mount(LlamaCppBrowserDownloadJob, { props: { job, acceptLocalInput, disabled: false, appearance: 'welcome', density, sourcesVisibility: 'hidden' } });
  const hint = wrapper.getComponent(HuggingFaceDownloadFailureHint);
  expect(wrapper.get('[role="alert"]').element.nextElementSibling).toBe(hint.element);
  expect(wrapper.find('[data-testid="download-file-recovery"]').exists()).toBe(false);
  expect(acceptLocalInput).not.toHaveBeenCalled();
  await hint.get('[data-testid="hf-download-failure-trigger"]').trigger('click');
  const recovery = wrapper.getComponent({ name: 'LlamaCppBrowserLocalFileRecovery' });
  expect(recovery.props('acceptLocalInput')).toBe(acceptLocalInput);
  expect(recovery.props('disabled')).toBe(false);
  expect(hint.element.contains(recovery.element)).toBe(true);
  expect(acceptLocalInput).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: true });
  expect(recovery.props('disabled')).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-download-resume"]').element.disabled).toBe(true);
  expect(acceptLocalInput).not.toHaveBeenCalled();
});
