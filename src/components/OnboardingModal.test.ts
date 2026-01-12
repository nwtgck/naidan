import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import OnboardingModal from './OnboardingModal.vue';
import { useSettings } from '../composables/useSettings';
import { Settings } from 'lucide-vue-next';
import * as llm from '../services/llm';

// Mock the services.
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: vi.fn(),
    OllamaProvider: vi.fn(),
  };
});

// Mock the composables
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

describe('OnboardingModal.vue', () => {
  const mockSave = vi.fn();
  const mockSettings = { value: { endpointType: 'openai', autoTitleEnabled: true } };
  const listModelsMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useSettings as unknown as Mock).mockReturnValue({
      settings: mockSettings,
      save: mockSave,
      initialized: { value: true },
    });
    
    listModelsMock.mockResolvedValue(['model-1']);
    
    // Setup provider mocks to return an object with listModels
    (llm.OpenAIProvider as unknown as Mock).mockImplementation(function() {
      return { listModels: listModelsMock };
    });
    (llm.OllamaProvider as unknown as Mock).mockImplementation(function() {
      return { listModels: listModelsMock };
    });
  });

  it('renders Step 1 by default and shows correct labels', () => {
    const wrapper = mount(OnboardingModal);
    expect(wrapper.text()).toContain('Setup Endpoint');
    expect(wrapper.find('input').exists()).toBe(true);
    expect(wrapper.text()).toContain('OpenAI-compatible');
    expect(wrapper.text()).toContain('Ollama');
  });

  it('shows the skip icon on the skip button', () => {
    const wrapper = mount(OnboardingModal);
    const skipBtn = wrapper.find('button.underline');
    expect(skipBtn.find('svg').exists()).toBe(true);
  });

  it('disables the connection button when URL is empty', () => {
    const wrapper = mount(OnboardingModal);
    const connectBtn = wrapper.find('button.bg-blue-600');
    expect((connectBtn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the connection button for valid URLs even without schema', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('localhost:11434');
    
    const connectBtn = wrapper.find('button.bg-blue-600');
    expect((connectBtn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('automatically prepends http:// to URLs', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('localhost:1234');
    
    // Click Connect
    await wrapper.find('button.bg-blue-600').trigger('click');
    await flushPromises();

    // Provider should have been called with prepended http://
    expect(listModelsMock).toHaveBeenCalledWith('http://localhost:1234', expect.anything());
  });

  it('shows error when skipping with an empty URL', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('');
    
    const skipBtn = wrapper.find('button.underline');
    await skipBtn.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Please enter a valid URL before skipping.');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('allows skipping with a valid URL (even without test)', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('localhost:8080'); // Test normalization too
    
    await wrapper.find('button.underline').trigger('click');
    await flushPromises();

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://localhost:8080',
    }));
  });

  it('proceeds to Step 2 after successful connection', async () => {
    listModelsMock.mockResolvedValue(['model-1', 'model-2']);
    const wrapper = mount(OnboardingModal);

    await wrapper.find('input').setValue('http://localhost:1234');
    await wrapper.find('button.bg-blue-600').trigger('click');
    
    await flushPromises();
    await nextTick();

    expect(listModelsMock).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Successfully Connected!');
    expect(wrapper.find('select').exists()).toBe(true);
  });

  it('applies the backdrop blur class to the overlay', () => {
    const wrapper = mount(OnboardingModal);
    const overlay = wrapper.find('div.fixed.inset-0');
    expect(overlay.classes()).toContain('backdrop-blur-[2px]');
  });

  it('has a fixed height and correct footer icon', () => {
    const wrapper = mount(OnboardingModal);
    // Use max-w-4xl to find the container, then check classes
    const modalContainer = wrapper.find('.max-w-4xl');
    expect(modalContainer.exists()).toBe(true);
    expect(modalContainer.classes()).toContain('h-[680px]');
    
    // Check for the settings icon in the footer
    const footer = wrapper.find('div.p-6.border-t');
    expect(footer.findComponent(Settings).exists()).toBe(true);
  });
});