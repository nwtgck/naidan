import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    run: vi.fn().mockImplementation(() => Promise.resolve()),
  },
}));

describe('BlockMarkdownRenderer: Mermaid Support', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('recognizes mermaid code blocks', () => {
    const content = `\
${'```'}mermaid
graph TD;
    A-->B;
${'```'}
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      preserveClasses: ['mermaid-block', 'mermaid'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    // Should render the MermaidBlock component which has .mermaid-block class
    expect(dom).toContain('class="mermaid-block"');
    expect(dom).toContain('class="mermaid"');
  });
});
