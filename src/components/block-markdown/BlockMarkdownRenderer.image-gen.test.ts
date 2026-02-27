import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';

// Mock storageService
vi.mock('../../services/storage', () => ({
  storageService: {
    getFile: vi.fn(),
    init: vi.fn(),
  }
}));

describe('BlockMarkdownRenderer: Image Generation Blocks', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('detects naidan_experimental_image code block and renders GeneratedImageBlock', () => {
    const json = JSON.stringify({
      binaryObjectId: 'img_123',
      prompt: 'A beautiful sunset',
      width: 512,
      height: 512,
      displayWidth: 300,
      displayHeight: 300
    });

    const content = `\
${'```'}naidan_experimental_image
${json}
${'```'}
`;
    const wrapper = mountRenderer({ content });

    // We need to preserve the identifying class to verify it rendered correctly
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      preserveClasses: ['naidan-generated-image'], // Preserve the class we are looking for
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });

    expect(dom).toContain('class="naidan-generated-image"');
    expect(dom).not.toContain('<pre');
  });
});
