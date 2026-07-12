import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import JsonCodeView from './JsonCodeView.vue';

describe('JsonCodeView', () => {
  it('renders highlighted JSON as text without interpreting HTML', () => {
    const wrapper = mount(JsonCodeView, {
      props: {
        source: '{"html":"<img src=x onerror=alert(1)>"}',
        displayMode: 'raw',
        overflowMode: 'scroll',
        heightMode: 'content',
      },
    });

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.find('.json-syntax-property').text()).toBe('"html"');
    expect(wrapper.find('.json-syntax-string').text()).toBe('"<img src=x onerror=alert(1)>"');
  });

  it('pretty-prints valid JSON and reports invalid JSON without replacing it', async () => {
    const wrapper = mount(JsonCodeView, {
      props: {
        source: '{"value":1}',
        displayMode: 'formatted',
        overflowMode: 'wrap',
        heightMode: 'content',
      },
    });

    expect(wrapper.text()).toContain('\n  "value": 1\n');
    expect(wrapper.find('pre').classes()).toContain('json-code-view--wrap');

    await wrapper.setProps({ source: '{broken' });
    wrapper.get('[data-testid="json-code-view-invalid"]');
    expect(wrapper.text()).toContain('{broken');
  });

  it('fills an explicitly bounded detail pane without imposing content height', () => {
    const wrapper = mount(JsonCodeView, {
      props: {
        source: '{"value":1}',
        displayMode: 'formatted',
        overflowMode: 'scroll',
        heightMode: 'fill',
      },
    });

    expect(wrapper.get('[data-testid="json-code-view"]').classes()).toEqual(expect.arrayContaining(['flex', 'h-full', 'flex-col']));
    expect(wrapper.get('pre').classes()).toEqual(expect.arrayContaining(['min-h-0', 'flex-1']));
  });

});
