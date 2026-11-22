import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerDelimitedView from './FileExplorerDelimitedView.vue';

function mountView({ text, mode, partial }: { text: string; mode: 'preview' | 'detail'; partial: boolean }) {
  const wrapper = mount(FileExplorerDelimitedView, {
    props: { text, format: 'csv', mode, partial, editable: true },
  });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('FileExplorerDelimitedView', () => {
  it('shows only complete preview rows with a truncation notice', () => {
    using view = mountView({ text: ['001,first', '002,cut'].join('\n'), mode: 'preview', partial: true });
    const { wrapper } = view;

    expect(wrapper.findAll('[data-testid="delimited-row"]')).toHaveLength(1);
    expect(wrapper.get('[data-testid="delimited-table"]').text()).toContain('001');
    expect(wrapper.get('[data-testid="delimited-partial"]').text()).toBe('Showing part of the file.');
    expect(wrapper.find('[data-testid="delimited-save"]').exists()).toBe(false);
  });

  it('preserves the draft until persistence supplies the saved text', async () => {
    using view = mountView({ text: '\uFEFF"001",first', mode: 'detail', partial: false });
    const { wrapper } = view;

    await wrapper.findAll('[data-testid="delimited-cell-button"]')[1]!.trigger('click');
    await wrapper.get('[data-testid="delimited-cell-input"]').setValue('new, value');
    expect(wrapper.emitted('dirtyChange')).toEqual([[{ dirty: true }]]);
    expect(wrapper.vm.getDraft()).toBe('\uFEFF"001","new, value"');

    await wrapper.get('[data-testid="delimited-save"]').trigger('click');
    expect(wrapper.emitted('save')).toEqual([[{ text: '\uFEFF"001","new, value"' }]]);
    expect(wrapper.vm.getDraft()).toBe('\uFEFF"001","new, value"');

    await wrapper.setProps({ text: '\uFEFF"001","new, value"' });
    expect(wrapper.vm.getDraft()).toBeUndefined();
    expect(wrapper.emitted('dirtyChange')).toEqual([[{ dirty: true }], [{ dirty: false }]]);
  });

  it('falls back to inert raw text when a complete file is malformed', () => {
    const text = '"unclosed,<img src=x>';
    using view = mountView({ text, mode: 'detail', partial: false });
    const { wrapper } = view;

    expect(wrapper.get('[data-testid="delimited-fallback"]').text()).toBe(text);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('[data-testid="delimited-save"]').exists()).toBe(false);
  });
});
