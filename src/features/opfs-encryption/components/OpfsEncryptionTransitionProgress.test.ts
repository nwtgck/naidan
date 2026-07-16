import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import OpfsEncryptionTransitionProgress from './OpfsEncryptionTransitionProgress.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('OpfsEncryptionTransitionProgress', () => {
  it('renders an indeterminate progress bar without requiring an expensive total-size pre-scan', () => {
    const wrapper = mount(OpfsEncryptionTransitionProgress, {
      props: {
        progress: {
          operation: 'encrypting',
          phase: 'copying',
          percent: undefined,
          completedBytes: 262144,
          totalBytes: undefined,
          completedEntries: 3,
          totalEntries: undefined,
        },
      },
    });

    const progressBar = wrapper.get('[role="progressbar"]');
    expect(progressBar.attributes('aria-valuenow')).toBeUndefined();
    expect(wrapper.find('[data-testid="opfs-encryption-transition-percent"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Copying data');
    expect(wrapper.text()).not.toContain('256 KiB');
  });

  it('renders exact verification progress after the copy establishes totals', () => {
    const wrapper = mount(OpfsEncryptionTransitionProgress, {
      props: {
        progress: {
          operation: 'decrypting',
          phase: 'verifying',
          percent: 75,
          completedBytes: 3145728,
          totalBytes: 4194304,
          completedEntries: 30,
          totalEntries: 40,
        },
      },
    });

    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('75');
    expect(wrapper.get('[data-testid="opfs-encryption-transition-percent"]').text()).toBe('75%');
    expect(wrapper.text()).toContain('Verifying copied data');
    expect(wrapper.text()).toContain('3.00 MiB / 4.00 MiB');
    expect(wrapper.text()).toContain('30 / 40 entries');
  });
});
