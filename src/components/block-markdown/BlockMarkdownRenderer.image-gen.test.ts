import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';
import { normalizeDom } from './test-utils';
import { IMAGE_BLOCK_LANG } from '@/utils/image-generation';

describe('BlockMarkdownRenderer: Image Generation Blocks', () => {
  const mountRenderer = ({ content }: { content: string }) => {
    return mount(BlockMarkdownRenderer, {
      props: { content }
    });
  };

  it('recognizes image generation blocks', () => {
    const imageData = {
      binaryObjectId: 'obj123',
      displayWidth: 512,
      displayHeight: 512,
      prompt: 'a prompt'
    };
    const content = `\
${'```'}${IMAGE_BLOCK_LANG}
${JSON.stringify(imageData)}
${'```'}
`;
    const wrapper = mountRenderer({ content });
    const dom = normalizeDom({
      element: wrapper.element,
      preserveAttributes: undefined,
      preserveClasses: ['naidan-generated-image'],
      trimWhitespaceNodes: true,
      whitespaceSensitiveTags: undefined
    });
    // Should render the GeneratedImageBlock component
    expect(dom).toContain('class="naidan-generated-image"');
  });

  it('renders fallback for invalid image block JSON', () => {
    const content = `\
${'```'}${IMAGE_BLOCK_LANG}
{ not valid json }
${'```'}
`;
    const wrapper = mountRenderer({ content });
    expect(wrapper.text()).toContain('Invalid Image Block Data');
  });
});
