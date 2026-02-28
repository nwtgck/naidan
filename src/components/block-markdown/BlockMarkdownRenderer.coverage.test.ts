import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

describe('BlockMarkdownRenderer: Token Coverage', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  const getDom = (wrapper: any) => normalizeDom({
    element: wrapper.element,
    preserveAttributes: ['src', 'href', 'checked', 'type', 'disabled'],
    trimWhitespaceNodes: true
  });

  it('safely ignores reference definitions (def)', () => {
    const content = `\
[label]: http://example.com "Title"

Just text`;
    const wrapper = mountRenderer({ content });
    const dom = getDom(wrapper);
    
    // def should be ignored, only paragraph should remain
    expect(dom).toContain('<span>Just text</span>');
    expect(dom).not.toContain('http://example.com');
  });

  it('renders hard line breaks (br)', () => {
    // Two spaces at the end of a line in Markdown produces a <br>
    const content = `\
Line 1  
Line 2`;
    const wrapper = mountRenderer({ content });
    const dom = getDom(wrapper);
    
    expect(dom).toContain('<span>Line 1<br>Line 2</span>');
  });

  it('handles inline elements when they appear as blocks', () => {
    const content = `\
**Strong text**

_Emphasized text_`;
    const wrapper = mountRenderer({ content });
    const dom = getDom(wrapper);
    
    expect(dom).toContain('<strong>Strong text</strong>');
    expect(dom).toContain('<em>Emphasized text</em>');
  });

  it('handles complex nesting cases', () => {
    const content = `\
> Blockquote
> 1. List item`;
    const wrapper = mountRenderer({ content });
    const dom = getDom(wrapper);
    
    // Explicitly verify the nesting: Blockquote > Paragraph > Span, and Blockquote > OL > LI > Span
    // Note: tight list items render text directly via MarkdownInline (span) without a wrapper paragraph.
    expect(dom).toContain('<blockquote><p><span>Blockquote</span></p><ol><li><span>List item</span></li></ol></blockquote>');
  });

  it('does not show "Unknown token type" for handled tokens', () => {
    const content = `\
---`;
    const wrapper = mountRenderer({ content });
    const dom = getDom(wrapper);
    
    // hr should be rendered
    expect(dom).toContain('<hr>');
    expect(dom).not.toContain('Unknown token type');
  });
});
