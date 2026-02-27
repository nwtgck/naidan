import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

describe('BlockMarkdownRenderer: Nested Structures', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('renders list items containing multiple paragraphs', () => {
    const content = `\
* item 1, para 1

  item 1, para 2
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    });
    // Loose list (multiple tokens) should still use wrapper div
    expect(dom).toContain('<li><div><p><span>item 1, para 1</span></p><p><span>item 1, para 2</span></p></div></li>');
  });

  it('renders a list inside a blockquote', () => {
    const content = `\
> * nested list item 1
> * nested list item 2
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('<blockquote><ul><li><span>nested list item 1</span></li><li><span>nested list item 2</span></li></ul></blockquote>');
  });

  it('renders a code block inside a list', () => {
    const content = `\
* step 1:
  ${'```'}js
  console.log("hello");
  ${'```'}
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    });
    // Code block inside list item
    expect(dom).toContain('<li><div><span>step 1:</span>');
    expect(dom).toContain('<pre>');
  });

  it('renders deeply nested blockquotes', () => {
    const content = `\
> level 1
>> level 2
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toBe('<div><blockquote><p><span>level 1</span></p><blockquote><p><span>level 2</span></p></blockquote></blockquote></div>');
  });
});
