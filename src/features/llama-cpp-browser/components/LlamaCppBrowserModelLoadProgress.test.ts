import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import LlamaCppBrowserModelLoadProgress from './LlamaCppBrowserModelLoadProgress.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('measured model load progress', () => {
  it('labels the measured percentage as model weights and returns to indeterminate initialization', async () => {
    const wrapper = mount(LlamaCppBrowserModelLoadProgress, { props: { progress: { phase: 'loading', completed: 37, total: 100 } } });
    expect(wrapper.get('[role="status"]').text()).toBe('Loading model…');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('37');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toBe('Loading model weights');
    await wrapper.setProps({ progress: { phase: 'initializing', completed: 0, total: 0 } });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.text()).not.toContain('%'); expect(wrapper.text()).toContain('context'); wrapper.unmount();
  });

  it.each([undefined, { phase: 'loading' as const, completed: 0, total: 0 }, { phase: 'loading' as const, completed: NaN, total: 1 }, { phase: 'generating' as const, completed: 5, total: 10 }])('does not turn unknown or unrelated progress into a load percentage', progress => {
    const wrapper = mount(LlamaCppBrowserModelLoadProgress, { props: { progress } });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined(); wrapper.unmount();
  });

  it.each([[-1, '0'], [2, '100']] as const)('bounds an observed fraction %s to %s', (completed, expected) => {
    const wrapper = mount(LlamaCppBrowserModelLoadProgress, { props: { progress: { phase: 'loading', completed, total: 1 } } });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe(expected); wrapper.unmount();
  });
});
