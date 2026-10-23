import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import PromptApiPreparationProgress from './PromptApiPreparationProgress.vue';

enableAutoUnmount(afterEach);

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PromptApiPreparationProgress', () => {
  it('renders unknown and measured download progress without starting browser work', async () => {
    const availability = vi.fn();
    const create = vi.fn();
    vi.stubGlobal('LanguageModel', { availability, create });
    const wrapper = mount(PromptApiPreparationProgress, {
      props: { state: { status: 'downloading', progress: undefined } },
    });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.find('[data-testid="prompt-api-download-progress-indeterminate"]').exists()).toBe(true);

    await wrapper.setProps({ state: { status: 'downloading', progress: 0 } });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('0');
    await wrapper.setProps({ state: { status: 'downloading', progress: 0.356 } });
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('36');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-label')).toContain('36%');
    expect(wrapper.get('[data-testid="prompt-api-download-progress-determinate"]').attributes('style')).toContain('width: 36%');
    expect(wrapper.find('[data-testid="prompt-api-download-progress-indeterminate"]').exists()).toBe(false);
    expect(availability).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('replaces the completed download with preparation rather than leaving a stale percentage', async () => {
    const wrapper = mount(PromptApiPreparationProgress, {
      props: { state: { status: 'downloading', progress: 1 } },
    });
    expect(wrapper.text()).toContain('100%');
    await wrapper.setProps({ state: { status: 'preparing' } });
    expect(wrapper.text()).toContain('Preparing browser-provided model');
    expect(wrapper.text()).not.toContain('%');
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
  });
});
