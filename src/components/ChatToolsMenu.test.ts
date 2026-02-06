import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatToolsMenu from './ChatToolsMenu.vue';

describe('ChatToolsMenu', () => {
  const defaultProps = {
    canGenerateImage: true,
    isProcessing: false,
    isImageMode: false,
    selectedWidth: 512,
    selectedHeight: 512,
    availableImageModels: ['model-1', 'model-2'],
    selectedImageModel: 'model-1'
  };

  it('renders the tools button', () => {
    const wrapper = mount(ChatToolsMenu, { props: defaultProps });
    expect(wrapper.find('[data-testid="chat-tools-button"]').exists()).toBe(true);
  });

  it('toggles menu on click', async () => {
    const wrapper = mount(ChatToolsMenu, { props: defaultProps });
    const button = wrapper.find('[data-testid="chat-tools-button"]');
    
    await button.trigger('click');
    expect(wrapper.text()).toContain('Experimental Tools');
    
    await button.trigger('click');
    expect(wrapper.find('.absolute').exists()).toBe(false);
  });

  it('emits toggle-image-mode when clicking the image mode button', async () => {
    const wrapper = mount(ChatToolsMenu, { props: defaultProps });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    
    const toggleButton = wrapper.find('[data-testid="toggle-image-mode-button"]');
    await toggleButton.trigger('click');
    
    expect(wrapper.emitted('toggle-image-mode')).toBeTruthy();
  });

  it('shows resolution and model selectors when image mode is on', async () => {
    const wrapper = mount(ChatToolsMenu, { 
      props: { ...defaultProps, isImageMode: true } 
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    
    expect(wrapper.text()).toContain('Image Model');
    expect(wrapper.text()).toContain('Resolution');
    
    const resButtons = wrapper.findAll('button').filter(b => /^\d+x\d+$/.test(b.text()));
    expect(resButtons.length).toBe(3); // 256x256, 512x512, 1024x1024
  });

  it('emits update:resolution when a resolution is selected', async () => {
    const wrapper = mount(ChatToolsMenu, { 
      props: { ...defaultProps, isImageMode: true } 
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    
    const res256 = wrapper.findAll('button').find(b => b.text() === '256x256');
    await res256?.trigger('click');
    
    expect(wrapper.emitted('update:resolution')).toEqual([[256, 256]]);
  });

  it('shows empty state when no tools are available', async () => {
    const wrapper = mount(ChatToolsMenu, { 
      props: { ...defaultProps, canGenerateImage: false } 
    });
    await wrapper.find('[data-testid="chat-tools-button"]').trigger('click');
    
    expect(wrapper.text()).toContain('No tools available for this provider');
  });
});
