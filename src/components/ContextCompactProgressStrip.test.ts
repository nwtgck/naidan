import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ContextCompactProgressStrip from './ContextCompactProgressStrip.vue';

describe('ContextCompactProgressStrip', () => {
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
});
