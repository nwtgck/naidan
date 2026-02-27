import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
  }
}));

describe('BlockMarkdownRenderer: Mermaid Rendering', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('detects mermaid code blocks and renders MermaidBlock component', () => {
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
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    // Verify toolbar buttons are present
    expect(dom).toContain('<button');
    expect(dom).toContain('Copy Source');
    // Verify the mermaid source is there
    expect(dom).toContain('graph TD;');
  });
});
