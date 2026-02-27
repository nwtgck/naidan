import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

describe('BlockMarkdownRenderer: Lists and Tables', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('renders a basic bulleted list', () => {
    const content = `\
* item 1
* item 2
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('<ul><li><div><div><span>item 1</span></div></div></li><li><div><div><span>item 2</span></div></div></li></ul>');
  });

  it('renders task lists', () => {
    const content = `\
* [ ] todo
* [x] done
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: ['type', 'checked', 'disabled'],
      preserveClasses: ['list-none', 'list-disc', 'list-inside', 'ml-1'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    // Check for list-none and the adjusted margin
    expect(dom).toContain('class="list-none ml-1"');    expect(dom).not.toContain('list-inside');
    expect(dom).toContain('type="checkbox"');
    expect(dom).toContain('todo');
  });

  it('renders tables', () => {
    const content = `\
| A | B |
|---|---|
| 1 | 2 |
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('<table>');
    expect(dom).toContain('<thead>');
    expect(dom).toContain('<tbody>');
    expect(dom).toContain('<span>1</span>');
  });
});
