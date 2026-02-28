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
      preserveClasses: ['list-disc', 'ml-6'],
      whitespaceSensitiveTags: undefined
    });
    // Verify direct span inside li (no div wrapper for single items)
    expect(dom).toContain('<ul class="list-disc ml-6"><li><span>item 1</span></li><li><span>item 2</span></li></ul>');
  });

  it('renders an ordered list', () => {
    const content = `\
1. first
2. second
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      preserveClasses: ['list-decimal', 'ml-6'],
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('<ol class="list-decimal ml-6"><li><span>first</span></li><li><span>second</span></li></ol>');
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
      preserveClasses: ['list-none', 'ml-2'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('class="list-none ml-2"');
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
    expect(dom).toContain('<span>1</span>');
  });
});
