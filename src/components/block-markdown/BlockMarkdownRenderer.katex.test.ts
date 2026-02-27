import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

describe('BlockMarkdownRenderer: KaTeX Rendering', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('renders inline math', () => {
    const content = `Math: $E=mc^2$`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      preserveClasses: ['katex'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    // Check if the 'katex' class is present
    expect(dom).toContain('class="katex"');
  });

  it.todo('renders block math', () => {
    // Ensure empty lines around $$ for reliable block detection
    const content = `\
Some text

$$
\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

More text
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      preserveClasses: ['katex-display'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    // With proper spacing, marked-katex-extension should trigger
    expect(dom).toContain('class="katex-display"');
  });
});
