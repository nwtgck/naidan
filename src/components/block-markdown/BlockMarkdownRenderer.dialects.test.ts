import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

describe('BlockMarkdownRenderer: Markdown Dialects (GFM etc)', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('renders strikethrough (~~)', () => {
    const content = `\
~~deleted text~~
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toBe('<div><p><span><del>deleted text</del></span></p></div>');
  });

  it('auto-links URLs', () => {
    const content = `\
Check https://google.com for info.
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: ['href'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('<a href="https://google.com">https://google.com</a>');
  });

  it('renders tables even without a trailing pipe', () => {
    const content = `\
| Column A | Column B
| --- | ---
| Row 1 | Row 2
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    expect(dom).toContain('<table><thead><tr><th><span>Column A</span></th><th><span>Column B</span></th></tr></thead><tbody><tr><td><span>Row 1</span></td><td><span>Row 2</span></td></tr></tbody></table>');
  });
});
