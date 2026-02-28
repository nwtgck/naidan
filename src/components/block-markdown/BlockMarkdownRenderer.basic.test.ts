import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

describe('BlockMarkdownRenderer: Basic Syntax', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('renders a simple paragraph', () => {
    const wrapper = mountRenderer({ content: `\
Hello World
` });
    expect(normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><p><span>Hello World</span></p></div>');
  });

  it('renders bold and italic text', () => {
    const wrapper = mountRenderer({ content: `\
**Bold** and *Italic*
` });
    expect(normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><p><span><strong>Bold</strong> and <em>Italic</em></span></p></div>');
  });

  it('renders headings (h1-h6)', () => {
    const h1 = mountRenderer({ content: `\
# Heading 1
` });
    expect(normalizeDom({
      element: h1.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><h1><span>Heading 1</span></h1></div>');

    const h2 = mountRenderer({ content: `\
## Heading 2
` });
    expect(normalizeDom({
      element: h2.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><h2><span>Heading 2</span></h2></div>');

    const h6 = mountRenderer({ content: `\
###### Heading 6
` });
    expect(normalizeDom({
      element: h6.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><h6><span>Heading 6</span></h6></div>');
  });

  it('renders links', () => {
    const wrapper = mountRenderer({ content: `\
[Google](https://google.com)
` });
    expect(normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><p><span><a href="https://google.com">Google</a></span></p></div>');
  });

  it('renders images', () => {
    const wrapper = mountRenderer({ content: `\
![Alt text](https://example.com/image.png)
` });
    // Should render the placeholder now for external URLs
    expect(wrapper.find('.naidan-external-image-placeholder').exists()).toBe(true);
    expect(wrapper.text()).toContain('Alt text');
  });

  it('renders internal or data-url images directly', () => {
    const content = '![Data URL](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==)';
    const wrapper = mountRenderer({ content });

    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).toContain('data:image/png;base64');
  });

  it('renders horizontal rules', () => {
    const wrapper = mountRenderer({ content: `\
---
` });
    expect(normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><hr></div>');
  });

  it('renders inline code', () => {
    const wrapper = mountRenderer({ content: `\
Use \`code\` here
` });
    expect(normalizeDom({
      element: wrapper.element,
      trimWhitespaceNodes: true,
      preserveAttributes: undefined,
      whitespaceSensitiveTags: undefined
    })).toBe('<div><p><span>Use <code>code</code> here</span></p></div>');
  });
});
