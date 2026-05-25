import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ContextCompactProgressStrip from './ContextCompactProgressStrip.vue';

describe('ContextCompactProgressStrip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders request and output previews while compacting', async () => {
    const wrapper = mount(ContextCompactProgressStrip, {
      props: {
        progress: {
          phase: 'receiving_compact',
          compactedMessageCount: 4,
          suffixMessageCount: 6,
          outputChars: 42,
          requestPreview: `\
[user]
Question`,
          outputPreview: '# Compact Context',
        },
      },
    });

    expect(wrapper.find('[data-testid="context-compact-progress-strip"]').exists()).toBe(true);

    // Output should be visible by default
    expect(wrapper.find('[data-testid="context-compact-output-preview"]').text()).toContain('# Compact Context');

    // Request should be hidden by default
    expect(wrapper.find('[data-testid="context-compact-request-scroll"]').exists()).toBe(false);

    // Clicking toggle should show request
    await wrapper.find('[data-testid="context-compact-request-toggle"]').trigger('click');
    expect(wrapper.find('[data-testid="context-compact-request-scroll"]').text()).toContain('Question');
  });

  it('animates the visible percent instead of snapping immediately to 25', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(0), 0);
    });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => {
      window.clearTimeout(handle);
    });

    const wrapper = mount(ContextCompactProgressStrip, {
      props: {
        progress: {
          phase: 'requesting_model',
          compactedMessageCount: 4,
          suffixMessageCount: 6,
          requestPreview: 'Request preview',
        },
      },
    });

    expect(wrapper.vm.TEST_ONLY.animatedPercent.value).toBe(0);

    await nextTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(wrapper.vm.TEST_ONLY.animatedPercent.value).toBe(25);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
  });

  it('keeps the complete state visible briefly before hiding', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(0), 0);
    });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => {
      window.clearTimeout(handle);
    });

    const wrapper = mount(ContextCompactProgressStrip, {
      props: {
        progress: {
          phase: 'complete',
          requestPreview: undefined,
          outputPreview: '# Compact Context',
        },
      },
    });

    await nextTick();
    await vi.advanceTimersByTimeAsync(0);

    expect(wrapper.find('[data-testid="context-compact-progress-strip"]').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(299);
    expect(wrapper.find('[data-testid="context-compact-progress-strip"]').exists()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await nextTick();
    expect(wrapper.find('[data-testid="context-compact-progress-strip"]').exists()).toBe(false);

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
  });
});
