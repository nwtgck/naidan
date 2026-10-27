import { mount } from '@vue/test-utils';
import { defineComponent, h, Teleport, type PropType } from 'vue';
import { describe, expect, it } from 'vitest';
import { provideLlamaCppBrowserSettingsTypography, useLlamaCppBrowserSettingsTypography } from './useLlamaCppBrowserSettingsTypography';

const Reader = defineComponent({
  setup() {
    const settingsTypography = useLlamaCppBrowserSettingsTypography();
    return () => h('output', settingsTypography.value ? 'settings' : 'embedded');
  },
});
const Scope = defineComponent({
  props: { presentation: { type: String as PropType<'settings' | 'embedded'>, required: true } },
  setup(props, { slots }) {
    provideLlamaCppBrowserSettingsTypography({ presentation: () => props.presentation });
    return () => h('section', slots.default?.());
  },
});

describe('llama.cpp browser settings typography boundary', () => {
  it('keeps standalone readers embedded and isolates a nested embedded manager', () => {
    const standalone = mount(Reader);
    const wrapper = mount(Scope, {
      props: { presentation: 'settings' },
      slots: { default: () => [h(Reader), h(Scope, { presentation: 'embedded' }, { default: () => h(Reader) })] },
    });
    using fixture = {
      standalone,
      wrapper,
      [Symbol.dispose]() {
        standalone.unmount();
        wrapper.unmount();
      },
    };
    expect(fixture.standalone.text()).toBe('embedded');
    expect(fixture.wrapper.findAll('output').map(reader => reader.text())).toEqual(['settings', 'embedded']);
  });

  it('updates an existing teleported reader when its manager presentation changes', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const wrapper = mount(Scope, {
      props: { presentation: 'settings' },
      slots: { default: () => h(Teleport, { to: target }, h(Reader)) },
    });
    using fixture = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
        target.remove();
      },
    };
    const reader = target.querySelector('output');
    expect(reader?.textContent).toBe('settings');
    await fixture.wrapper.setProps({ presentation: 'embedded' });
    expect(target.querySelector('output')).toBe(reader);
    expect(reader?.textContent).toBe('embedded');
  });
});
