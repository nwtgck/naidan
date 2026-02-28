import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';

describe('BlockMarkdownRenderer: Streaming Update Stability', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('keeps existing blocks stable when appending content', async () => {
    const initialContent = `\
# Hello

`;
    const wrapper = mountRenderer({ content: initialContent });

    // Capture the first h1 element
    const firstH1 = wrapper.find('h1').element;
    expect(firstH1.textContent).toBe('Hello');

    // Append a paragraph
    await wrapper.setProps({ content: initialContent + 'Streaming world...' });
    await nextTick();

    // The h1 should still be the same instance
    expect(wrapper.find('h1').element).toBe(firstH1);
    expect(wrapper.find('p').text()).toBe('Streaming world...');
  });

  it('correctly handles incomplete block tokens during stream', async () => {
    // Stage 1: Partial list
    const wrapper = mountRenderer({ content: `\
* item 1` });
    expect(wrapper.find('li').text()).toBe('item 1');

    // Stage 2: Second item being typed
    await wrapper.setProps({ content: `\
* item 1
* item 2` });
    await nextTick();
    const items = wrapper.findAll('li');
    expect(items.length).toBe(2);
    expect(items[1]?.text()).toBe('item 2');
  });

  it('maintains table structure while cells are being filled', async () => {
    // Stage 1: Header only
    const headerOnly = `\
| A | B |
|---|---|
`;
    const wrapper = mountRenderer({ content: headerOnly });
    expect(wrapper.findAll('th').length).toBe(2);
    expect(wrapper.find('tbody').findAll('tr').length).toBe(0);

    // Stage 2: Partial row
    await wrapper.setProps({ content: headerOnly + '| 1 |' });
    await nextTick();

    // Stage 3: Closed row
    await wrapper.setProps({ content: headerOnly + '| 1 | 2 |\n' });
    await nextTick();
    const cells = wrapper.find('tbody').findAll('td');
    expect(cells.length).toBe(2);
    expect(cells[0]?.text()).toBe('1');
  });

  it('re-renders specialized blocks when their content changes', async () => {
    const initialCode = `\
${'```'}js
const a = 1;
${'```'}
`;
    const wrapper = mountRenderer({ content: initialCode });

    // Changing the code content should replace the block or its inner HTML
    await wrapper.setProps({ content: `\
${'```'}js
const a = 2;
${'```'}
` });
    await nextTick();

    expect(wrapper.find('code').text()).toContain('a = 2');
  });
});
