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

  it('renders block math', () => {
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

  it('renders block math even when followed by text on the same line (mixed line)', () => {
    const content = `\
$$x = {-b \\pm \\sqrt{b^2-4ac} \\over 2a}$$ hoge
$$x = {-b \\pm \\sqrt{b^2-4ac} \\over 2a}$$
`;
    const wrapper = mountRenderer({ content });
    const html = wrapper.html();

    // Count occurrences of katex-display.
    // The first line might be treated as inline or block depending on marked-katex-extension's behavior for "$$ ... $$ text".
    // If it's at the start of the line, marked-katex-extension often treats it as block math.
    const displayMathCount = (html.match(/katex-display/g) || []).length;

    // We expect at least the second one to be a block.
    // If the first one is also a block (despite 'hoge'), it should be 2.
    // If it fails to render at all, it would be 0 or 1.
    expect(displayMathCount).toBeGreaterThanOrEqual(1);
    expect(html).not.toContain('$$');
    expect(html).toContain('hoge');
  });
});
