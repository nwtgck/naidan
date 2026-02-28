import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';

describe('BlockMarkdownRenderer: Inline Code Styling', () => {
  it('renders inline code with a <code> tag inside a paragraph', () => {
    const content = 'The result is `1 + 2`.';
    const wrapper = mount(BlockMarkdownRenderer, {
      props: { content }
    });

    const p = wrapper.find('p');
    expect(p.exists()).toBe(true);

    const code = p.find('code');
    expect(code.exists()).toBe(true);
    expect(code.text()).toBe('1 + 2');

    // Check if it has the expected base styles from tailwind typography or custom ones
    // We can check classes if we add them, or just verify it's NOT a <pre> tag
    expect(code.element.parentElement?.tagName).not.toBe('PRE');
  });

  it('renders inline code at the block level (tight lists etc) correctly', () => {
    const content = '- `item code`';
    const wrapper = mount(BlockMarkdownRenderer, {
      props: { content }
    });

    const code = wrapper.find('code');
    expect(code.exists()).toBe(true);
    expect(code.text()).toBe('item code');
    expect(wrapper.find('pre').exists()).toBe(false);
  });

  it('renders a standalone codespan token correctly as <code>', () => {
    // In some cases, a codespan might be passed directly as a token.
    // This happens in tight lists or other nested structures.
    const content = '`item code`'; // If this were a top-level token, it should still work.
    const wrapper = mount(BlockMarkdownRenderer, {
      props: { content }
    });

    // In a normal paragraph, it's wrapped in <p>
    const code = wrapper.find('code');
    expect(code.exists()).toBe(true);
    expect(code.text()).toBe('item code');
    // Ensure backticks are NOT in the text (meaning it was parsed correctly)
    expect(code.text()).not.toContain('`');
  });

  it('renders complex inline code with spaces correctly', () => {
    const content = 'Test `1 + 2` here.';
    const wrapper = mount(BlockMarkdownRenderer, {
      props: { content }
    });

    const code = wrapper.find('code');
    expect(code.exists()).toBe(true);
    expect(code.text()).toBe('1 + 2');
  });

  it('renders block code with <pre> and <code> correctly', () => {
    const content = '```js\nconsole.log(1);\n```';
    const wrapper = mount(BlockMarkdownRenderer, {
      props: { content }
    });

    const pre = wrapper.find('pre');
    expect(pre.exists()).toBe(true);

    const code = pre.find('code');
    expect(code.exists()).toBe(true);
    expect(code.text()).toContain('console.log(1)');
  });

  it('distinguishes between inline code and block code in the same content', () => {
    const content = 'Use `inline` or:\n\n```js\nblock();\n```';
    const wrapper = mount(BlockMarkdownRenderer, {
      props: { content }
    });

    const allCodes = wrapper.findAll('code');
    expect(allCodes).toHaveLength(2);

    // Inline code (inside a paragraph, no pre)
    const inlineCode = allCodes.find(c => c.element.parentElement?.tagName === 'SPAN' || c.element.parentElement?.tagName === 'P');
    expect(inlineCode?.text()).toBe('inline');

    // Block code (inside pre)
    const blockCode = wrapper.find('pre code');
    expect(blockCode.exists()).toBe(true);
    expect(blockCode.text()).toContain('block();');
  });
});
