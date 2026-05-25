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
        initialInstruction: 'Default compact prompt',
      },
    });

    const buttons = wrapper.findAll('button');
    const confirmButton = buttons[buttons.length - 1];

    expect(confirmButton?.attributes('disabled')).toBeDefined();

    await confirmButton?.trigger('click');

    expect(wrapper.emitted('confirm')).toBeUndefined();
  });

  it('shows an instruction preview and emits edited instruction on confirm', async () => {
    const wrapper = mount(ContextCompactSettingsDialog, {
      props: {
        isOpen: true,
        totalMessages: 9,
        initialKeepCount: 6,
        initialInstruction: 'Default compact prompt that should be visible in preview form.',
      },
    });

    expect(wrapper.text()).toContain('Default compact prompt');

    await wrapper.find('[data-testid="context-compact-instruction-toggle"]').trigger('click');
    await wrapper.find('[data-testid="context-compact-instruction-editor"]').setValue('Edited compact prompt');

    const buttons = wrapper.findAll('button');
    const confirmButton = buttons[buttons.length - 1];
    await confirmButton?.trigger('click');

    expect(wrapper.emitted('confirm')).toEqual([
      [
        {
          keepCount: 6,
          instruction: 'Edited compact prompt',
        },
      ],
    ]);
  });
});
