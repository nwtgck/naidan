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

  describe('details and summary handling', () => {
    it('renders basic details and summary', () => {
      const content = `\
<details>
<summary>Click to expand</summary>
Content
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      expect(dom).toContain('<details><summary><span>Click to expand</span></summary><div><p><span>Content</span></p></div></details>');
    });

    it('handles nested markdown inside details', () => {
      const content = `\
<details>
<summary>Expand me</summary>

- Item 1
- Item 2

**Bold**
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      expect(dom).toContain('<details><summary><span>Expand me</span></summary><div><ul><li><span>Item 1</span></li><li><span>Item 2</span></li></ul><p><span><strong>Bold</strong></span></p></div></details>');
    });

    it('handles nested details tags', () => {
      const content = `\
<details>
<summary>Outer</summary>

<details>
<summary>Inner</summary>
Inner content
</details>
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      // Verify the outer details contains the inner details
      expect(dom).toContain('<details><summary><span>Outer</span></summary>');
      expect(dom).toContain('<details><summary><span>Inner</span></summary>');
      expect(dom).toContain('<span>Inner content</span>');
      // Verify nested structure: details > div > details
      expect(dom).toMatch(/<details>.*<summary>.*Outer.*<\/summary>.*<div>.*<details>.*<summary>.*Inner.*<\/summary>/);
    });

    it('handles complex inline content in summary', () => {
      const content = `\
<details>
<summary>**Bold** [Link](http://example.com) \`code\`</summary>
Body
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      // Note: normalizeDom with trimWhitespaceNodes: true removes spaces between inline elements
      expect(dom).toContain('<summary><span><strong>Bold</strong><a href="http://example.com">Link</a><code>code</code></span></summary>');
    });

    it('handles various block types inside details', () => {
      const content = `\
<details>
<summary>Blocks</summary>

# Heading
| col1 |
| --- |
| val1 |

${'```'}js
const x = 1;
${'```'}

> Quote
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      expect(dom).toContain('<summary><span>Blocks</span></summary>');
      expect(dom).toContain('<h1><span>Heading</span></h1>');
      expect(dom).toContain('<table>');
      expect(dom).toContain('<code><span>const</span> x = <span>1</span>;</code>');
      expect(dom).toContain('<blockquote>');
    });

    it('handles details without a summary', () => {
      const content = `\
<details>
Just content
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      // Should render details tag without a summary tag (browser will use default)
      expect(dom).toContain('<details><div><p><span>Just content</span></p></div></details>');
      expect(dom).not.toContain('<summary>');
    });

    it('handles multiple details in sequence', () => {
      const content = `\
<details>
<summary>First</summary>
Content 1
</details>

<details>
<summary>Second</summary>
Content 2
</details>`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      expect(dom).toContain('<details><summary><span>First</span></summary>');
      expect(dom).toContain('<details><summary><span>Second</span></summary>');
    });

    it('handles details inside a list item', () => {
      const content = `\
- Item 1
- <details><summary>Nested Details</summary>Hidden in list</details>
- Item 2`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      // Verify the details is nested inside a list item (li)
      expect(dom).toContain('<ul><li><span>Item 1</span></li><li><details><summary><span>Nested Details</span></summary>');
      expect(dom).toContain('<span>Hidden in list</span>');
      expect(dom).toContain('</details></li><li><span>Item 2</span></li></ul>');
    });

    it('handles details inside a blockquote', () => {
      const content = `\
> Quote start
> <details><summary>Details in quote</summary>Hidden</details>
> Quote end`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      expect(dom).toContain('<blockquote><p><span>Quote start</span></p><details><summary><span>Details in quote</span></summary>');
      expect(dom).toContain('<span>Hidden</span>');
      expect(dom).toContain('</details><p><span>Quote end</span></p></blockquote>');
    });

    it('handles details inside a table cell', () => {
      const content = `\
| Table |
| --- |
| <details><summary>In Cell</summary>Value</details> |`;
      const wrapper = mountRenderer({ content });
      const dom = getDom(wrapper);

      // In table cells, details are handled as standard HTML by marked
      expect(dom).toContain('<td><span><details><summary>In Cell</summary>Value</details></span></td>');
    });
  });
});
