import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import MessageItem from './MessageItem.vue';
import { createImageRequestMarker, SENTINEL_IMAGE_REQUEST_PREFIX } from '../utils/image-generation';

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    getFile: vi.fn(),
    getBinaryObject: vi.fn(),
    subscribeToChanges: vi.fn(),
    loadSettings: vi.fn().mockResolvedValue({}),
    saveSettings: vi.fn(),
  }
}));

// Mock speech service
vi.mock('../services/web-speech', () => ({
  webSpeechService: {
    state: { status: 'inactive' },
    isSupported: vi.fn().mockReturnValue(true),
    speak: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn()
  }
}));

describe('MessageItem Edit Image Generation', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'user') => ({
    id: 'msg-123',
    role,
    content,
    timestamp: Date.now(),
    replies: { items: [] }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('populates image generation parameters when editing an image request', async () => {
    const params = {
      width: 1024,
      height: 1024,
      model: 'x/z-image-turbo:v1',
      count: 3,
      persistAs: 'webp' as const
    };
    const marker = createImageRequestMarker(params);
    const content = 'A majestic mountain range';
    const message = createMessage(`${marker}\n${content}`);

    const wrapper = mount(MessageItem, {
      props: { 
        message, 
        canGenerateImage: true,
        availableImageModels: ['x/z-image-turbo:v1', 'x/other-model:v1']
      }
    });

    // Enter edit mode
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    await nextTick();

    expect(wrapper.find('[data-testid="edit-mode"]').exists()).toBe(true);
    
    // Check if ChatToolsMenu received correct props
    const toolsMenu = wrapper.findComponent({ name: 'ChatToolsMenu' });
    expect(toolsMenu.exists()).toBe(true);
    expect(toolsMenu.props('isImageMode')).toBe(true);
    expect(toolsMenu.props('selectedWidth')).toBe(1024);
    expect(toolsMenu.props('selectedCount')).toBe(3);
    expect(toolsMenu.props('selectedPersistAs')).toBe('webp');
    expect(toolsMenu.props('selectedImageModel')).toBe('x/z-image-turbo:v1');
    expect(toolsMenu.props('direction')).toBe('down');

    // Textarea should contain only the prompt, without markers
    const textarea = wrapper.find('textarea');
    expect(textarea.element.value).toBe(content);
  });

  it('emits edit event with updated marker when parameters are changed', async () => {
    const originalParams = { width: 512, height: 512, count: 1, persistAs: 'original' as const };
    const marker = createImageRequestMarker(originalParams);
    const content = 'A cute cat';
    const message = createMessage(`${marker}\n${content}`);

    const wrapper = mount(MessageItem, {
      props: { 
        message, 
        canGenerateImage: true,
        availableImageModels: ['x/z-image-turbo:v1']
      }
    });

    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    await nextTick();

    const toolsMenu = wrapper.findComponent({ name: 'ChatToolsMenu' });
    
    // Simulate changing resolution and count via emits
    await toolsMenu.vm.$emit('update:resolution', 256, 256);
    await toolsMenu.vm.$emit('update:count', 4);
    await toolsMenu.vm.$emit('update:persist-as', 'png');

    // Save changes
    await wrapper.find('[data-testid="save-edit"]').trigger('click');

    const emitted = wrapper.emitted('edit');
    expect(emitted).toBeTruthy();
    const [msgId, newContent] = emitted![0] as [string, string];
    
    expect(msgId).toBe(message.id);
    expect(newContent).toContain(SENTINEL_IMAGE_REQUEST_PREFIX);
    expect(newContent).toContain('"width":256');
    expect(newContent).toContain('"count":4');
    expect(newContent).toContain('"persistAs":"png"');
    expect(newContent).toContain('A cute cat');
  });

  it('can convert a regular message to an image request', async () => {
    const content = 'Convert me to an image';
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { 
        message, 
        canGenerateImage: true,
        availableImageModels: ['x/z-image-turbo:v1']
      }
    });

    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    await nextTick();

    const toolsMenu = wrapper.findComponent({ name: 'ChatToolsMenu' });
    expect(toolsMenu.props('isImageMode')).toBe(false);

    // Toggle image mode on
    await toolsMenu.vm.$emit('toggle-image-mode');
    
    await wrapper.find('[data-testid="save-edit"]').trigger('click');

    const emitted = wrapper.emitted('edit');
    const [_, newContent] = emitted![0] as [string, string];
    expect(newContent).toContain(SENTINEL_IMAGE_REQUEST_PREFIX);
    expect(newContent).toContain('Convert me to an image');
  });

  it('can convert an image request back to a regular message', async () => {
    const marker = createImageRequestMarker({ width: 512, height: 512, persistAs: 'original' });
    const content = 'I want to be text only';
    const message = createMessage(`${marker}\n${content}`);

    const wrapper = mount(MessageItem, {
      props: { 
        message, 
        canGenerateImage: true,
        availableImageModels: ['x/z-image-turbo:v1']
      }
    });

    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    await nextTick();

    const toolsMenu = wrapper.findComponent({ name: 'ChatToolsMenu' });
    expect(toolsMenu.props('isImageMode')).toBe(true);

    // Toggle image mode off
    await toolsMenu.vm.$emit('toggle-image-mode');
    
    await wrapper.find('[data-testid="save-edit"]').trigger('click');

    const emitted = wrapper.emitted('edit');
    const [_, newContent] = emitted![0] as [string, string];
    expect(newContent).not.toContain(SENTINEL_IMAGE_REQUEST_PREFIX);
    expect(newContent).toBe('I want to be text only');
  });

  it('maintains intentional leading whitespace for regular messages', async () => {
    const content = '    Indent is important';
    const message = createMessage(content);

    const wrapper = mount(MessageItem, {
      props: { message, canGenerateImage: false }
    });

    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    await nextTick();

    const textarea = wrapper.find('textarea');
    expect(textarea.element.value).toBe(content);

    await wrapper.find('[data-testid="save-edit"]').trigger('click');
    const [_, newContent] = (wrapper.emitted('edit')![0] as [string, string]);
    expect(newContent).toBe(content); // Should not be trimStart'ed
  });
});
