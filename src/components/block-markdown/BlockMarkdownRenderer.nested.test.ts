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
    expect(dom).toContain('item 1, para 1');
    expect(dom).toContain('item 1, para 2');
    expect(dom).toContain('<p>');
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
    expect(dom).toContain('<blockquote>');
    expect(dom).toContain('<ul>');
    expect(dom).toContain('nested list item 1');
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
    // Check for the presence of code and pre block
    expect(dom).toContain('console');
    expect(dom).toContain('log');
    expect(dom).toContain('hello');
    expect(dom).toContain('<pre>');
  });
});
