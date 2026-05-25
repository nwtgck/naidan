import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ContextCompactSettingsDialog from './ContextCompactSettingsDialog.vue';

describe('ContextCompactSettingsDialog', () => {
  it('prevents confirming when there are no messages to compact', async () => {
    const wrapper = mount(ContextCompactSettingsDialog, {
      props: {
        isOpen: true,
        totalMessages: 6,
        initialKeepCount: 6,
      },
    });

    const buttons = wrapper.findAll('button');
    const confirmButton = buttons[buttons.length - 1];

    expect(confirmButton?.attributes('disabled')).toBeDefined();

    await confirmButton?.trigger('click');

    expect(wrapper.emitted('confirm')).toBeUndefined();
  });
});
