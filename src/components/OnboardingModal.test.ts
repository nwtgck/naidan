import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import OnboardingModal from './OnboardingModal.vue';
import { useSettings } from '../composables/useSettings';
import * as llm from '../services/llm';

// Mock the composables
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

// Mock the services. We use function() so it can be used with 'new'
vi.mock('../services/llm', () => {
  const mockListModels = vi.fn();
  return {
    OpenAIProvider: vi.fn().mockImplementation(function() {
      return { listModels: mockListModels };
    }),
    OllamaProvider: vi.fn().mockImplementation(function() {
      return { listModels: mockListModels };
    }),
  };
});

describe('OnboardingModal.vue', () => {
  const mockSave = vi.fn();
  const mockSettings = { value: { endpointType: 'openai', autoTitleEnabled: true } };

  beforeEach(() => {
    vi.clearAllMocks();
    (useSettings as unknown as Mock).mockReturnValue({
      settings: mockSettings,
      save: mockSave,
      initialized: { value: true },
    });
  });

  it('renders Step 1 by default', () => {
    const wrapper = mount(OnboardingModal);
    expect(wrapper.text()).toContain('Setup Endpoint');
    expect(wrapper.find('input').exists()).toBe(true);
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
    const mockListModels = vi.fn().mockResolvedValue(['model-1']);
    (llm.OpenAIProvider as unknown as Mock).mockImplementation(function() {
      return { listModels: mockListModels };
    });

    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('localhost:1234');
    
    // Click Connect
    await wrapper.find('button.bg-blue-600').trigger('click');
    await flushPromises();

    // Provider should have been called with prepended http://
    expect(mockListModels).toHaveBeenCalledWith('http://localhost:1234', expect.anything());
    
    // In Step 2, the normalized URL should be displayed as text
    expect(wrapper.text()).toContain('http://localhost:1234');
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
      defaultModelId: undefined,
    }));
  });

  it('proceeds to Step 2 after successful connection', async () => {
    const mockListModels = vi.fn().mockResolvedValue(['model-1']);
    (llm.OpenAIProvider as unknown as Mock).mockImplementation(function() {
      return { listModels: mockListModels };
    });

    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('http://localhost:1234/v1');
    await wrapper.find('button.bg-blue-600').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Successfully Connected!');
    expect(wrapper.find('select').exists()).toBe(true);
  });

  it('applies the weakened backdrop blur class to the overlay', () => {
    const wrapper = mount(OnboardingModal);
    const overlay = wrapper.find('.backdrop-blur-\\[2px\\]');
    expect(overlay.exists()).toBe(true);
  });
});