import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { IMAGE_BLOCK_LANG } from '@/utils/image-generation';

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockImplementation(() => Promise.resolve()),
  },
});

// Mock mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    run: vi.fn().mockImplementation(() => Promise.resolve()),
  },
}));

describe('BlockMarkdownRenderer: Interactive Features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  describe('StandardCodeBlock Features', () => {
    it('displays the correct language label', () => {
      const content = `\
${'```'}typescript
const x = 1;
${'```'}
`;
      const wrapper = mountRenderer({ content });
      expect(wrapper.text()).toContain('typescript');
    });

    it('copies code to clipboard when copy button is clicked', async () => {
      const content = `\
${'```'}js
console.log(1);
${'```'}
`;
      const wrapper = mountRenderer({ content });
      const copyButton = wrapper.find('button[title="Copy code"]');
      expect(copyButton.exists()).toBe(true);

      await copyButton.trigger('click');
      // Verify clipboard content (no trailing newline in the source string)
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('console.log(1);');

      // Verify the button title changes to 'Copied'
      expect(copyButton.attributes('title')).toBe('Copied');
    });

    it('toggles line wrap when wrap button is clicked', async () => {
      const content = `\
${'```'}js
console.log("this is a very long line that should potentially wrap if the setting is enabled");
${'```'}
`;
      const wrapper = mountRenderer({ content });
      const wrapButton = wrapper.find('button[title="Toggle line wrap"]');
      expect(wrapButton.exists()).toBe(true);

      const pre = wrapper.find('pre');

      // Initially should be whitespace-pre (default)
      expect(pre.classes()).toContain('whitespace-pre');
      expect(pre.classes()).not.toContain('whitespace-pre-wrap');

      // Click to enable wrap
      await wrapButton.trigger('click');
      expect(pre.classes()).toContain('whitespace-pre-wrap');
      expect(pre.classes()).not.toContain('whitespace-pre');

      // Click to disable wrap
      await wrapButton.trigger('click');
      expect(pre.classes()).toContain('whitespace-pre');
      expect(pre.classes()).not.toContain('whitespace-pre-wrap');
    });
  });

  describe('MermaidBlock Features', () => {
    it('renders mermaid block and allows mode switching', async () => {
      const content = `\
${'```'}mermaid
graph TD; A-->B;
${'```'}
`;
      const wrapper = mountRenderer({ content });

      // Default should show preview
      const previewArea = wrapper.find('.mermaid');
      expect(previewArea.exists()).toBe(true);

      // Switch to Code mode
      const codeButton = wrapper.find('button[title="Code"]');
      await codeButton.trigger('click');

      expect(wrapper.text()).toContain('graph TD; A-->B;');
    });

    it('copies mermaid source to clipboard', async () => {
      const content = `\
${'```'}mermaid
graph TD; A-->B;
${'```'}
`;
      const wrapper = mountRenderer({ content });
      // Find the "Copy Source" button using the title
      const copyButton = wrapper.find('button[title="Copy Source"]');
      expect(copyButton.exists()).toBe(true);

      await copyButton.trigger('click');
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('graph TD; A-->B;');
    });
  });

  describe('GeneratedImageBlock Features', () => {
    it('shows error message for invalid JSON', () => {
      const content = `\
${'```'}${IMAGE_BLOCK_LANG}
{ invalid json }
${'```'}
`;
      const wrapper = mountRenderer({ content });
      expect(wrapper.text()).toContain('Invalid Image Block Data');
    });

    it('parses valid JSON and shows skeleton during load', () => {
      const imageData = {
        binaryObjectId: 'obj123',
        displayWidth: 512,
        displayHeight: 512,
        prompt: 'a beautiful sunset'
      };
      const content = `\
${'```'}${IMAGE_BLOCK_LANG}
${JSON.stringify(imageData)}
${'```'}
`;
      const wrapper = mountRenderer({ content });

      // Should show skeleton while loading
      expect(wrapper.find('.naidan-image-skeleton').exists()).toBe(true);
    });
  });
});
