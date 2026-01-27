import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import OnboardingModal from './OnboardingModal.vue';
import ThemeToggle from './ThemeToggle.vue';
import { useSettings } from '../composables/useSettings';
import { useToast } from '../composables/useToast';
import { useTheme } from '../composables/useTheme';
import { Settings } from 'lucide-vue-next';
import * as llm from '../services/llm';
import { type EndpointType } from '../models/types';

// Mock the services.
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: vi.fn(),
    OllamaProvider: vi.fn(),
  };
});

// Mock the composables
vi.mock('../composables/useSettings', () => ({ useSettings: vi.fn() }));
vi.mock('../composables/useToast', () => ({ useToast: vi.fn() }));
vi.mock('../composables/useTheme', () => ({ useTheme: vi.fn() }));

describe('OnboardingModal.vue', () => {
  const mockSave = vi.fn();
  const mockSettings = { value: { endpointType: 'openai', autoTitleEnabled: true } };
  const mockIsOnboardingDismissed = { value: false };
  const mockOnboardingDraft = { value: null as { url: string, type: EndpointType, models: string[], selectedModel: string } | null };
  const mockAddToast = vi.fn();
  const listModelsMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnboardingDismissed.value = false;
    mockOnboardingDraft.value = null;
    (useSettings as unknown as Mock).mockReturnValue({
      settings: mockSettings,
      save: mockSave,
      initialized: { value: true },
      isOnboardingDismissed: mockIsOnboardingDismissed,
      onboardingDraft: mockOnboardingDraft,
      availableModels: ref([]),
      isFetchingModels: ref(false),
      fetchModels: vi.fn(),
      setIsOnboardingDismissed: (val: boolean) => { mockIsOnboardingDismissed.value = val; },
      setOnboardingDraft: (val: any) => { mockOnboardingDraft.value = val; },
    });

    (useToast as unknown as Mock).mockReturnValue({
      addToast: mockAddToast,
    });

    (useTheme as unknown as Mock).mockReturnValue({
      themeMode: { value: 'system' },
      setTheme: vi.fn(),
    });
    
    listModelsMock.mockResolvedValue(['model-1']);
    
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

  it('disables the connection button when URL is empty', () => {
    const wrapper = mount(OnboardingModal);
    const connectBtn = wrapper.find('[data-testid="onboarding-connect-button"]');
    expect((connectBtn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the connection button for valid URLs even without schema', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('localhost:11434');
    
    const connectBtn = wrapper.find('[data-testid="onboarding-connect-button"]');
    expect((connectBtn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('automatically prepends http:// to URLs', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('localhost:1234');
    
    // Click Connect
    await wrapper.find('[data-testid="onboarding-connect-button"]').trigger('click');
    await flushPromises();

    // Provider should have been called with prepended http://
    expect(listModelsMock).toHaveBeenCalledWith('http://localhost:1234', [], expect.anything());
  });

  it('dismisses onboarding and saves draft when X is clicked', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('http://localhost:11434');
    
    const closeBtn = wrapper.find('[data-testid="onboarding-close-x"]');
    await closeBtn.trigger('click');
    await flushPromises();

    expect(mockOnboardingDraft.value).toEqual(expect.objectContaining({
      url: 'http://localhost:11434',
    }));
    expect(mockSave).not.toHaveBeenCalled(); // Should NOT save settings permanently
    expect(mockIsOnboardingDismissed.value).toBe(true);
    expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({
      actionLabel: 'Undo',
    }));
  });

  it('re-enables onboarding when UNDO action is triggered from toast', async () => {
    const wrapper = mount(OnboardingModal);
    mockIsOnboardingDismissed.value = false;
    
    await wrapper.find('[data-testid="onboarding-close-x"]').trigger('click');
    await flushPromises();

    expect(mockIsOnboardingDismissed.value).toBe(true);
    
    // Get the onAction from the toast call
    const toastOptions = mockAddToast.mock.calls[0]![0];
    toastOptions.onAction();

    expect(mockIsOnboardingDismissed.value).toBe(false);
  });

  it('proceeds to Step 2 and persists settings only on "Get Started"', async () => {
    listModelsMock.mockResolvedValue(['model-1', 'model-2']);
    const wrapper = mount(OnboardingModal);

    await wrapper.find('input').setValue('http://localhost:1234');
    await wrapper.find('[data-testid="onboarding-connect-button"]').trigger('click');
    
    await flushPromises();
    await nextTick();

    expect(listModelsMock).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Successfully Connected!');
    expect(mockSave).not.toHaveBeenCalled(); // Not saved yet

    // Test finishing Step 2
    await wrapper.find('[data-testid="onboarding-finish-button"]').trigger('click'); // "Get Started" button
    await flushPromises();

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://localhost:1234',
      defaultModelId: 'model-1',
    }));
    expect(mockOnboardingDraft.value).toBe(null); // Draft cleared on success
    expect(mockIsOnboardingDismissed.value).toBe(true);
  });

  it('applies the backdrop blur class to the overlay', () => {
    const wrapper = mount(OnboardingModal);
    const overlay = wrapper.find('div.fixed.inset-0');
    expect(overlay.classes()).toContain('backdrop-blur-[2px]');
  });

  it('has a fixed height and correct footer icon', () => {
    const wrapper = mount(OnboardingModal);
    const modalContainer = wrapper.find('.max-w-4xl');
    expect(modalContainer.exists()).toBe(true);
    expect(modalContainer.classes()).toContain('h-[640px]');
    
    expect(wrapper.findComponent(Settings).exists()).toBe(true);
  });

  it('renders ThemeToggle in the header', () => {
    const wrapper = mount(OnboardingModal);
    expect(wrapper.findComponent(ThemeToggle).exists()).toBe(true);
  });

  it('applies a lower opacity to the setup guide by default and increases it on hover', () => {
    const wrapper = mount(OnboardingModal);
    // Use substring match for classes with colons or brackets to avoid selector errors
    const guideWrapper = wrapper.find('div[class*="opacity-70"][class*="hover:opacity-100"]');
    
    expect(guideWrapper.exists()).toBe(true);
    expect(guideWrapper.classes()).toContain('opacity-70');
    expect(guideWrapper.classes()).toContain('transition-opacity');
  });

  it('has a distinct background for the help column to separate it from the main content', () => {
    const wrapper = mount(OnboardingModal);
    // Find the right column by its structural width class using substring match
    const helpColumn = wrapper.find('div[class*="lg:w-[38%]"]');
    
    expect(helpColumn.exists()).toBe(true);
    expect(helpColumn.classes()).toContain('bg-gray-50/30');
    expect(helpColumn.classes()).toContain('border-gray-100');
  });

  it('restores draft state (including models) when reopened', async () => {
    mockOnboardingDraft.value = { 
      url: 'http://restored-url:11434', 
      type: 'ollama',
      models: ['model-a', 'model-b'],
      selectedModel: 'model-b',
    };

    const wrapper = mount(OnboardingModal);
    
    // Should be in Step 2 directly because models exist
    expect(wrapper.text()).toContain('Successfully Connected!');
    expect(wrapper.text()).toContain('http://restored-url:11434');
    
    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    expect(trigger.text()).toBe('model-b');
    
    await trigger.trigger('click');
    const modelButtons = wrapper.findAll('.custom-scrollbar button').filter(b => 
      ['model-a', 'model-b'].includes(b.text())
    );
    expect(modelButtons.length).toBe(2);
  });

  it('shows error message when saving settings fails', async () => {
    const wrapper = mount(OnboardingModal);
    
    // Connect successfully first to get to Step 2
    listModelsMock.mockResolvedValue(['model-1']);
    await wrapper.find('input').setValue('http://localhost:11434');
    await wrapper.find('[data-testid="onboarding-connect-button"]').trigger('click');
    await flushPromises();
    await nextTick();

    mockSave.mockRejectedValueOnce(new Error('Persistent Storage Error'));
    
    // Click "Get Started"
    await wrapper.find('[data-testid="onboarding-finish-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Persistent Storage Error');
  });

  it('resets models and returns to Step 1 when Back button is clicked', async () => {
    // Start at Step 2 by providing models in the draft
    mockOnboardingDraft.value = { 
      url: 'http://localhost:11434', 
      type: 'ollama',
      models: ['model-1'],
      selectedModel: 'model-1',
    };
    const wrapper = mount(OnboardingModal);
    
    expect(wrapper.text()).toContain('Successfully Connected!');
    
    // Find and click Back button (the one with ArrowLeft)
    const backBtn = wrapper.findAll('button').find(b => b.text().includes('Back'));
    await backBtn?.trigger('click');
    
    expect(wrapper.text()).toContain('Setup Endpoint');
    expect(wrapper.find('input').exists()).toBe(true);
  });

  it('cancels connection attempt when Cancel is clicked', async () => {
    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('http://localhost:11434');
    
    // Mock a slow connection
    listModelsMock.mockReturnValue(new Promise(() => {})); // Never resolves
    
    await wrapper.find('[data-testid="onboarding-connect-button"]').trigger('click');
    expect(wrapper.text()).toContain('Connecting');
    
    const cancelBtn = wrapper.findAll('button').find(b => b.text().includes('Cancel'));
    await cancelBtn?.trigger('click');
    
    expect(wrapper.text()).not.toContain('Connecting');
    expect(wrapper.text()).toContain('Connection attempt cancelled');
  });

  it('preserves normalized URL and selected model through a Skip and Undo cycle', async () => {
    listModelsMock.mockResolvedValue(['model-x', 'model-y']);
    const wrapper = mount(OnboardingModal);
    
    // 1. Connect and go to Step 2
    await wrapper.find('input').setValue('localhost:11434 '); // With trailing space
    await wrapper.find('[data-testid="onboarding-connect-button"]').trigger('click');
    await flushPromises();
    
    // 2. Select second model
    const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    const modelYBtn = wrapper.findAll('button').find(b => b.text() === 'model-y');
    await modelYBtn?.trigger('click');
    
    // 3. Skip via X
    await wrapper.find('[data-testid="onboarding-close-x"]').trigger('click');
    expect(mockIsOnboardingDismissed.value).toBe(true);
    
    // 4. Trigger Undo from toast
    const toastOptions = mockAddToast.mock.calls[0]![0];
    toastOptions.onAction();
    expect(mockIsOnboardingDismissed.value).toBe(false);
    
    // 5. Verify state is exactly as it was
    await nextTick();
    expect(wrapper.text()).toContain('Successfully Connected!');
    expect(wrapper.text()).toContain('http://localhost:11434'); // Normalized URL shown in text
    expect(wrapper.find('[data-testid="model-selector-trigger"]').text()).toBe('model-y');
  });

  it('applies animation classes for entrance effects', () => {
    const wrapper = mount(OnboardingModal);
    
    // Check modal content animation class
    const modalContent = wrapper.find('.modal-content-zoom');
    expect(modalContent.exists()).toBe(true);
  });

  it('supports adding and removing custom HTTP headers in UI', async () => {
    // Prevent transition to Step 2
    listModelsMock.mockReturnValue(new Promise(() => {})); 

    const wrapper = mount(OnboardingModal);
    await wrapper.find('input').setValue('http://localhost:11434');
    
    // Click Add Header
    const addBtn = wrapper.findAll('button').find(b => b.text().includes('Add Header'));
    await addBtn?.trigger('click');
    
    const inputs = wrapper.findAll('input');
    // First input is URL, then Name, then Value
    expect(inputs.length).toBe(3);
    
    await inputs[1]?.setValue('X-Test-Header');
    await inputs[2]?.setValue('Test-Value');
    
    // Click Connect and verify headers are passed
    await wrapper.find('[data-testid="onboarding-connect-button"]').trigger('click');
    
    expect(listModelsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([['X-Test-Header', 'Test-Value']]),
      expect.anything()
    );
    
    // Remove header
    const removeBtn = wrapper.findAll('button').find(b => b.findComponent({ name: 'Trash2' }).exists() || b.html().includes('lucide-trash2'));
    await removeBtn?.trigger('click');
    expect(wrapper.findAll('input').length).toBe(1); // Only URL input left
  });

  it('passes a naturally sorted list of models to ModelSelector', async () => {
    mockOnboardingDraft.value = { 
      url: 'http://localhost:11434', 
      type: 'ollama',
      models: ['model-10', 'model-2', 'model-1'],
      selectedModel: 'model-1',
    };

    const wrapper = mount(OnboardingModal, {
      global: {
        stubs: {
          ModelSelector: {
            name: 'ModelSelector',
            template: '<div class="model-selector-stub" />',
            props: ['models']
          }
        }
      }
    });
    
    const selector = wrapper.getComponent({ name: 'ModelSelector' });
    expect(selector.props('models')).toEqual(['model-1', 'model-2', 'model-10']);
  });
});
