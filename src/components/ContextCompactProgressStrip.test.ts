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
    expect(wrapper.find('[data-testid="context-compact-details"]').attributes('open')).toBeUndefined();

    const details = wrapper.find('[data-testid="context-compact-details"]');
    details.element.setAttribute('open', '');
    await details.trigger('toggle');

    expect(wrapper.find('[data-testid="context-compact-request-preview"]').text()).toContain('Question');
    expect(wrapper.find('[data-testid="context-compact-output-preview"]').text()).toContain('# Compact Context');
  });
});
