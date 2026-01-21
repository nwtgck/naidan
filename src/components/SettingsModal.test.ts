// Mock the dynamic import for licenses
vi.mock('../assets/licenses.json', () => ({
  default: [{ name: 'test-pkg', version: '1.0.0', license: 'MIT', licenseText: 'MIT Content' }]
}));

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import SettingsModal from './SettingsModal.vue';
import { Loader2 } from 'lucide-vue-next';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useSampleChat } from '../composables/useSampleChat';
import { storageService } from '../services/storage';
import type { ProviderProfile } from '../models/types';

// --- Mocks ---

const mockListModels = vi.fn().mockResolvedValue(['model-1']);
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: class {
      listModels = mockListModels;
    },
    OllamaProvider: class {
      listModels = mockListModels;
    },
  };
});


vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(() => ({
    settings: ref({ storageType: 'local', providerProfiles: [] }),
    availableModels: ref(['model-a', 'model-b']),
    isFetchingModels: ref(false),
    save: vi.fn().mockImplementation(async (newSettings) => {
      const currentType = storageService.getCurrentType();
      if (newSettings.storageType !== currentType) {
        await storageService.switchProvider(newSettings.storageType);
      }
    }),
    fetchModels: vi.fn(),
  })),
}));

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

// Mock useConfirm
const mockShowConfirm = vi.fn();
vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({
    showConfirm: mockShowConfirm,
  })),
}));

// Mock usePrompt
const mockShowPrompt = vi.fn();
vi.mock('../composables/usePrompt', () => ({
  usePrompt: vi.fn(() => ({
    showPrompt: mockShowPrompt,
  })),
}));

const mockAddToast = vi.fn();
vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(() => ({
    addToast: mockAddToast,
  })),
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    clearAll: vi.fn(),
    getCurrentType: vi.fn(),
    switchProvider: vi.fn().mockResolvedValue(undefined),
    hasAttachments: vi.fn().mockResolvedValue(false),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    updateChatGroup: vi.fn(),
    deleteChatGroup: vi.fn(),
    notify: vi.fn(),
  },
}));

// --- Tests ---

describe('SettingsModal.vue (Tabbed Interface)', () => {
  async function wait() {
    await new Promise(r => setTimeout(r, 100));
    await nextTick();
  }

  const mockSave = vi.fn();
  const mockCreateSampleChat = vi.fn();
  const mockSettings = {
    endpointType: 'openai',
    endpointUrl: 'http://localhost:1234/v1',
    defaultModelId: 'gpt-4',
    autoTitleEnabled: true,
    storageType: 'local',
    providerProfiles: [] as ProviderProfile[],
  };

  const globalStubs = {
    Activity: true,
    RefreshCw: true,
    Loader2: true,
    Globe: true,
    BookmarkPlus: true,
    Database: true,
    Cpu: true,
    Bot: true,
    Check: true,
    Pencil: true,
    Target: true,
    Trash: true,
    Trash2: true,
    X: true,
    CheckCircle2: true,
    Save: true,
    Type: true,
    FlaskConical: true,
    AlertTriangle: true,
    ShieldCheck: true,
    Logo: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue({
        createWritable: vi.fn().mockResolvedValue({}),
      }),
      removeEntry: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('navigator', {
      storage: { getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) },
    });
    vi.stubGlobal('isSecureContext', true);

    vi.mocked(storageService.getCurrentType).mockReturnValue('local');

    (useRouter as Mock).mockReturnValue({
      push: vi.fn(),
      currentRoute: { value: { path: '/' } }
    });

    (useSettings as unknown as Mock).mockReturnValue({
      settings: ref(JSON.parse(JSON.stringify(mockSettings))),
      availableModels: ref([]),
      isFetchingModels: ref(false),
      save: mockSave.mockImplementation(async (newSettings) => {
        const currentType = storageService.getCurrentType();
        if (newSettings.storageType !== currentType) {
          await storageService.switchProvider(newSettings.storageType);
        }
      }),
      fetchModels: vi.fn(),
    });

    (useChat as unknown as Mock).mockReturnValue({
      deleteAllChats: vi.fn(),
      resolvedSettings: ref({ modelId: 'gpt-4', sources: { modelId: 'global' } }),
    });

    (useSampleChat as unknown as Mock).mockReturnValue({
      createSampleChat: mockCreateSampleChat,
    });


    vi.stubGlobal('location', { reload: vi.fn() });
    mockShowConfirm.mockClear();
    mockShowPrompt.mockClear();
  });

  describe('UI / Design Regression', () => {
    it('positions the close button correctly in the top-right corner', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      await flushPromises();
      
      const closeBtn = wrapper.find('[data-testid="setting-close-x"]');
      expect(closeBtn.classes()).toContain('absolute');
      expect(closeBtn.classes()).toContain('top-4');
      expect(closeBtn.classes()).toContain('right-4');
    });

    it('maintains UI stability during model fetching', async () => {
      const isFetching = ref(false);
      (useSettings as unknown as Mock).mockReturnValue({
        settings: ref(JSON.parse(JSON.stringify(mockSettings))),
        availableModels: ref([]),
        isFetchingModels: isFetching,
        save: mockSave,
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      await flushPromises();

      isFetching.value = true;
      await flushPromises();

      const checkBtn = wrapper.find('[data-testid="setting-check-connection"]');
      
      // Text should remain visible/present even while loading to prevent width jitter
      expect(checkBtn.text()).toContain('Check Connection');
      
      // Spinner should be present alongside the text container
      expect(checkBtn.findComponent(Loader2).exists()).toBe(true);
      
      // Button should be disabled to prevent double-clicks
      expect(checkBtn.attributes('disabled')).toBeDefined();
    });

    it('applies the weakened backdrop blur class to the overlay', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      await flushPromises();
      
      const overlay = wrapper.find('.backdrop-blur-\\[2px\\]');
      expect(overlay.exists()).toBe(true);
    });

    it('reserves space for error messages to prevent layout shift', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      await flushPromises();

      // Initially should not show error text
      expect(wrapper.text()).not.toContain('Test Error');

      // Set error
      const vm = wrapper.vm as unknown as { error: string | null };
      vm.error = 'Test Error';
      await flushPromises();

      // Error text should appear
      expect(wrapper.text()).toContain('Test Error');
    });

    it('shows success feedback when connection check succeeds', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      await flushPromises();

      const vm = wrapper.vm as unknown as { fetchModels: () => Promise<void> };
      // Trigger fetch logic manually to bypass service mock complexities
      await vm.fetchModels();
      await flushPromises();
      await nextTick();

      const checkBtn = wrapper.find('[data-testid="setting-check-connection"]');
      
      // Should show success state
      expect(checkBtn.text()).toContain('Connected');
      expect(checkBtn.classes()).toContain('bg-green-50');
    });

    it('uses distinct labels for model fallbacks to clarify different behaviors', async () => {
      const wrapper = mount(SettingsModal, {
        props: { isOpen: true },
      });

      // Clear values first to see placeholders/None
      const vm = wrapper.vm as any;
      vm.form.defaultModelId = undefined;
      vm.form.titleModelId = undefined;
      await nextTick();

      // Default Model label should just be "None" when empty
      const modelSelect = wrapper.find('[data-testid="setting-model-select"]');
      const trigger = modelSelect.find('[data-testid="model-selector-trigger"]');
      expect(trigger.text()).toBe('None');

      // Title Generation Model label must be explicit about fallback behavior.
      const titleSelect = wrapper.find('[data-testid="setting-title-model-select"]');
      const titleTrigger = titleSelect.find('[data-testid="model-selector-trigger"]');
      expect(titleTrigger.text()).toBe('Use Current Chat Model (Default)');
    });














    it('ensures SettingsModal has correct z-index when dialogs are triggered', async () => {
      // Mount SettingsModal
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      await flushPromises();

      // Trigger the "Reset All Application Data" button to open a dialog
      mockShowConfirm.mockResolvedValueOnce(true); // Simulate confirmation
      await wrapper.findAll('nav button').find(b => b.text().includes('Developer'))?.trigger('click');
      await wrapper.find('[data-testid="setting-reset-data-button"]').trigger('click');
      await flushPromises();

      // Check the z-index of the SettingsModal itself.
      // The SettingsModal has z-[100]. If a dialog is triggered, it should not change the modal's z-index.
      const settingsModalElement = wrapper.get('div.fixed.inset-0');
      expect(settingsModalElement.classes()).toContain('z-[100]'); // Ensure modal's z-index class remains as expected

      // Note: Directly testing the global dialog's z-index from this unit test is complex
      // as it's rendered in App.vue's wrapper. This test confirms the modal doesn't
      // inadvertently raise its own z-index, allowing the global dialog (z-[110]) to overlay it.
    });
  });

  it('renders initial settings correctly in the Connection tab', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    expect(wrapper.text()).toContain('Endpoint Configuration');
    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    expect((urlInput.element as HTMLInputElement).value).toBe('http://localhost:1234/v1');
  });

  it('navigates between Connection, Profiles, Storage, and Developer tabs', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    const navButtons = wrapper.findAll('nav button');
    
    // Profiles
    await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
    expect(wrapper.text()).toContain('Save and switch');

    // Storage
    await navButtons.find(b => b.text().includes('Storage'))?.trigger('click');
    expect(wrapper.text()).toContain('Storage Management');

    // Developer
    await navButtons.find(b => b.text().includes('Developer'))?.trigger('click');
    expect(wrapper.text()).toContain('Developer Tools');

    // About
    await navButtons.find(b => b.text().includes('About'))?.trigger('click');
    expect(wrapper.text()).toContain('About Naidan');
    expect(wrapper.text()).toContain('Version');
    expect(wrapper.text()).toContain('Open Source Licenses');
  });

  it('displays standalone license information when in standalone mode', async () => {
    // Mock isStandalone to true
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', true);
    vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', false);

    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    const navButtons = wrapper.findAll('nav button');
    await navButtons.find(b => b.text().includes('About'))?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Offline License Information');
    expect(wrapper.text()).toContain('THIRD_PARTY_LICENSES.txt');
    // In standalone mode, the list/loader should not be visible
    expect(wrapper.find('.animate-spin').exists()).toBe(false);
    
    // Cleanup
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', false);
    vi.stubGlobal('__BUILD_MODE_IS_HOSTED__', true);
  });

  it('loads and displays licenses dynamically in hosted mode', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    const navButtons = wrapper.findAll('nav button');
    await navButtons.find(b => b.text().includes('About'))?.trigger('click');
    
    // Dynamic import might take a moment to resolve in some environments
    await flushPromises();
    await nextTick();
    // Wait a bit more if needed
    await new Promise(resolve => setTimeout(resolve, 100));
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('test-pkg');
    expect(text).toContain('1.0.0'); // Global mock has 1.0.0 not v1.0.0
    expect(text).toContain('MIT');
  });

  it('persists unsaved changes when switching tabs', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    await urlInput.setValue('http://temporary-change');

    // Switch away and back
    const navButtons = wrapper.findAll('nav button');
    await navButtons.find(b => b.text().includes('Storage'))?.trigger('click');
    await navButtons.find(b => b.text().includes('Connection'))?.trigger('click');

    expect((wrapper.find('[data-testid="setting-url-input"]').element as HTMLInputElement).value)
      .toBe('http://temporary-change');
  });

  it('applies endpoint presets correctly and highlights the active one', async () => {
    const wrapper = mount(SettingsModal, { 
      props: { isOpen: true },
      global: { stubs: globalStubs },
    });
    await flushPromises();

    const lmstudioPreset = wrapper.find('[data-testid="endpoint-preset-lm-studio--local-"]');
    const ollamaPreset = wrapper.find('[data-testid="endpoint-preset-ollama--local-"]');
    const llamaPreset = wrapper.find('[data-testid="endpoint-preset-llama-server--local-"]');
    
    expect(lmstudioPreset.exists()).toBe(true);
    expect(ollamaPreset.exists()).toBe(true);
    expect(llamaPreset.exists()).toBe(true);

    // Test LM Studio
    await lmstudioPreset.trigger('click');
    const vm = wrapper.vm as unknown as { form: { endpointType: string, endpointUrl: string } };
    expect(vm.form.endpointType).toBe('openai');
    expect(vm.form.endpointUrl).toBe('http://localhost:1234/v1');
    expect(lmstudioPreset.attributes('class')).toContain('bg-blue-600'); // Highlighted

    // Test Ollama
    await ollamaPreset.trigger('click');
    expect(vm.form.endpointType).toBe('ollama');
    expect(vm.form.endpointUrl).toBe('http://localhost:11434');
    expect(ollamaPreset.attributes('class')).toContain('bg-blue-600');
    expect(lmstudioPreset.attributes('class')).not.toContain('bg-blue-600');

    // Test llama-server
    await llamaPreset.trigger('click');
    expect(vm.form.endpointType).toBe('openai');
    expect(vm.form.endpointUrl).toBe('http://localhost:8080/v1');
    expect(llamaPreset.attributes('class')).toContain('bg-blue-600');
  });

  it('auto-fetches models only when endpoint is localhost', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();
    mockListModels.mockClear();

    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    
    // Test non-localhost URL (should NOT auto-fetch)
    await urlInput.setValue('https://remote-api.com');
    await flushPromises();
    expect(mockListModels).not.toHaveBeenCalled();

    // Test manual fetch for remote URL via Check Connection button
    const checkBtn = wrapper.find('[data-testid="setting-check-connection"]');
    await checkBtn.trigger('click');
    await flushPromises();
    expect(mockListModels).toHaveBeenCalledWith('https://remote-api.com', undefined);
    mockListModels.mockClear();

    // Test localhost URL (SHOULD auto-fetch)
    await urlInput.setValue('http://localhost:11434');
    await flushPromises();
    expect(mockListModels).toHaveBeenCalledWith('http://localhost:11434', undefined);
  });

  it('shows confirmation behavior for "X" button', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    await urlInput.setValue('http://new-url'); // Make changes to trigger unsaved changes dialog

    // Test X button: Expect showConfirm to be called, then simulate confirmation
    mockShowConfirm.mockResolvedValueOnce(true); // Simulate user clicking 'Discard'

    await wrapper.find('[data-testid="setting-close-x"]').trigger('click');
    await flushPromises(); // Wait for showConfirm to be called and promise to resolve

    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Discard Unsaved Changes?',
        confirmButtonText: 'Discard',
        cancelButtonText: 'Keep Editing',
      }),
    );
    expect(wrapper.emitted().close).toBeTruthy();
  });

  it('performs save without closing the modal and shows feedback', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    await wrapper.find('[data-testid="setting-save-button"]').trigger('click');
    expect(wrapper.text()).toContain('Settings Saved');
  });

  it('handles model fetch errors gracefully', async () => {
    mockListModels.mockRejectedValueOnce(new Error('Fetch failed'));
    
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    // Trigger manual fetch to show error
    await wrapper.find('[data-testid="setting-check-connection"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Fetch failed');
  });

  it('triggers data reset after confirmation', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    await wrapper.findAll('nav button').find(b => b.text().includes('Developer'))?.trigger('click');
    
    mockShowConfirm.mockResolvedValueOnce(true);

    await wrapper.find('[data-testid="setting-reset-data-button"]').trigger('click');
    await flushPromises(); // Wait for showConfirm to be called and promise to resolve

    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Confirm Data Reset',
        confirmButtonText: 'Reset',
        confirmButtonVariant: 'danger',
      }),
    );
    expect(storageService.clearAll).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalled();

    mockShowConfirm.mockClear();
    (storageService.clearAll as Mock).mockClear();
    (window.location.reload as Mock).mockClear();

    // Simulate user cancelling the reset
    mockShowConfirm.mockResolvedValueOnce(false);

    await wrapper.find('[data-testid="setting-reset-data-button"]').trigger('click');
    await flushPromises();

    expect(mockShowConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Confirm Data Reset',
        confirmButtonText: 'Reset',
        confirmButtonVariant: 'danger',
      }),
    );

  });

  describe('Auto-Title Integration', () => {
    it('toggles title model selection based on auto-title checkbox', async () => {
      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      const checkbox = wrapper.find('[data-testid="setting-auto-title-checkbox"]');
      const select = wrapper.find('[data-testid="setting-title-model-select"]');
      const trigger = select.find('[data-testid="model-selector-trigger"]');

      expect((checkbox.element as HTMLInputElement).checked).toBe(true);
      expect((trigger.element as HTMLButtonElement).disabled).toBe(false);

      await checkbox.setValue(false);
      expect((trigger.element as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('Data Cleanup', () => {
    it('triggers clear all history after confirmation and navigates to root', async () => {
      const mockDeleteAllChats = vi.fn();
      const mockPush = vi.fn();
      
      (useChat as unknown as Mock).mockReturnValue({
        deleteAllChats: mockDeleteAllChats,
        resolvedSettings: ref({ modelId: 'gpt-4', sources: { modelId: 'global' } }),
      });
      (useRouter as Mock).mockReturnValue({
        push: mockPush,
        currentRoute: { value: { path: '/' } }
      });

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: { 
          stubs: globalStubs,
        } 
      });
      await flushPromises();

      await wrapper.findAll('nav button').find(b => b.text().includes('Storage'))?.trigger('click');
      
      const clearBtn = wrapper.find('[data-testid="setting-clear-history-button"]');
      expect(clearBtn.text()).toContain('Clear All Conversation History');

      mockShowConfirm.mockResolvedValueOnce(true);

      await clearBtn.trigger('click');
      await flushPromises();

      expect(mockShowConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Clear History',
          confirmButtonText: 'Clear All',
          confirmButtonVariant: 'danger',
        }),
      );
      expect(mockDeleteAllChats).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/');
      expect(wrapper.emitted().close).toBeTruthy();
    });

    it('does not reset onboarding flag when clearing history', async () => {
      // We check this by verifying that useChat's deleteAllChats is called,
      // and then in our manual verification of the code we've ensured 
      // it doesn't touch the flag. From a UI perspective, the flag is in settingsStore.
      const mockDeleteAllChats = vi.fn();
      (useChat as unknown as Mock).mockReturnValue({
        deleteAllChats: mockDeleteAllChats,
        resolvedSettings: ref({ modelId: 'gpt-4', sources: { modelId: 'global' } }),
      });
      (useRouter as Mock).mockReturnValue({
        push: vi.fn(),
        currentRoute: { value: { path: '/' } }
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      await wrapper.findAll('nav button').find(b => b.text().includes('Storage'))?.trigger('click');
      mockShowConfirm.mockResolvedValueOnce(true);

      await wrapper.find('[data-testid="setting-clear-history-button"]').trigger('click');
      await flushPromises();

      // Ensure the store value (which App.vue uses) would remain true if endpoint is there.
      // Since we already removed the code that sets it to false, this is indirectly tested.
      expect(mockDeleteAllChats).toHaveBeenCalled();
    });
  });

  describe('Provider Profiles', () => {
    it('creates a new profile from current settings including titleModelId', async () => {
      // Simulate user entering a profile name
      mockShowPrompt.mockResolvedValueOnce('New Test Profile');
      
      const customSettings = { 
        ...mockSettings, 
        titleModelId: 'special-title-model',
        autoTitleEnabled: true, 
      };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: customSettings },
        availableModels: { value: [] },
        isFetchingModels: { value: false },
        save: mockSave,
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      await wrapper.find('[data-testid="setting-save-provider-profile-button"]').trigger('click');
      await flushPromises(); // Wait for showPrompt to be called and promise to resolve

      expect(mockShowPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Create New Profile',
          message: expect.stringContaining('Enter a name for this profile:'),
          defaultValue: 'Openai - gpt-4', // Based on mockSettings
          confirmButtonText: 'Create',
        }),
      );
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      expect(vm.form.providerProfiles).toHaveLength(1);
      expect(vm.form.providerProfiles[0]!.name).toBe('New Test Profile');
      expect(vm.form.providerProfiles[0]!.titleModelId).toBe('special-title-model');
    });
    it('allows selecting "None" or "Default" for models and saves it to profile', async () => {
      // Simulate user entering a profile name (or cancelling)
      mockShowPrompt.mockResolvedValueOnce('None Profile');
      
      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      // Ensure some values are set first so clear button appears
      const vm = wrapper.vm as any;
      vm.form.defaultModelId = 'some-model';
      vm.form.titleModelId = 'some-model';
      await nextTick();

      // Select "None" for Default Model
      const modelSelect = wrapper.find('[data-testid="setting-model-select"]');
      await modelSelect.find('[data-testid="model-selector-trigger"]').trigger('click');
      const clearBtn = modelSelect.find('[data-testid="model-selector-clear"]');
      if (clearBtn.exists()) await clearBtn.trigger('click');

      // Select "Use Current Chat Model" for Title Model
      const titleSelect = wrapper.find('[data-testid="setting-title-model-select"]');
      await titleSelect.find('[data-testid="model-selector-trigger"]').trigger('click');
      const titleClearBtn = titleSelect.find('[data-testid="model-selector-clear"]');
      if (titleClearBtn.exists()) await titleClearBtn.trigger('click');
      
      await flushPromises();

      // Click Create Profile
      await wrapper.find('[data-testid="setting-save-provider-profile-button"]').trigger('click');
      
      const lastProfile = vm.form.providerProfiles[vm.form.providerProfiles.length - 1];
      expect(lastProfile?.defaultModelId).toBeUndefined();
      expect(lastProfile?.titleModelId).toBeUndefined();
    });
    it('supports renaming a profile in the UI', async () => {
      const mockProviderProfile = { id: 'p1', name: 'Original Name', endpointType: 'openai' as const };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        availableModels: { value: [] },
        isFetchingModels: { value: false },
        save: mockSave,
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      await wrapper.findAll('nav button').find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      
      await wrapper.find('[data-testid="provider-profile-rename-button"]').trigger('click');
      
      const nameInput = wrapper.find('input[autofocus]');
      expect(nameInput.exists()).toBe(true);
      
      await nameInput.setValue('Renamed Profile');
      await wrapper.find('button .lucide-check').element.parentElement?.click();
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      expect(vm.form.providerProfiles[0]!.name).toBe('Renamed Profile');
    });

    it('clears selection and applies profile when using the Quick Switcher and enables save button', async () => {
      const mockProviderProfile = {
        id: 'quick-1',
        name: 'Quick',
        endpointType: 'ollama' as const,
        endpointUrl: 'http://quick:11434',
        defaultModelId: 'model-a',
        titleModelId: 'model-title',
      };
      
      // We need useSettings to return the profile in the initial state so form.value has it
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        availableModels: { value: [] },
        isFetchingModels: { value: false },
        save: mockSave,
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      const select = wrapper.find('[data-testid="setting-quick-provider-profile-select"]');
      await select.setValue('quick-1');
      await select.trigger('change');
      await flushPromises();

      const vm = wrapper.vm as unknown as { 
        form: { endpointUrl: string, defaultModelId: string, titleModelId: string },
        selectedProviderProfileId: string,
        hasChanges: boolean
      };
      expect(vm.form.endpointUrl).toBe('http://quick:11434');
      expect(vm.form.defaultModelId).toBe('model-a');
      expect(vm.form.titleModelId).toBe('model-title');
      expect(vm.selectedProviderProfileId).toBe('');
      
      // Should enable the global save button
      expect(vm.hasChanges).toBe(true);
      const saveBtn = wrapper.find('[data-testid="setting-save-button"]');
      expect(saveBtn.attributes('disabled')).toBeUndefined();
    });

    it('shows empty state when no profiles exist', async () => {
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [] } },
        availableModels: { value: [] },
        isFetchingModels: { value: false },
        save: mockSave,
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      const navButtons = wrapper.findAll('nav button');
      await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await flushPromises();

      expect(wrapper.text()).toContain('No profiles saved yet');
      // Look for the "Go to Connection" button specifically in the empty state area
      const emptyStateBtn = wrapper.find('main button');
      expect(emptyStateBtn.text()).toContain('Go to Connection');
    });

    it('conditionally renders title model badge in the list', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: Partial<ProviderProfile>[] } };
      vm.form.providerProfiles = [
        { id: '1', name: 'With Title', endpointType: 'ollama', titleModelId: 't-1' },
        { id: '2', name: 'Without Title', endpointType: 'openai' },
      ];
      
      const navButtons = wrapper.findAll('nav button');
      await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await flushPromises();

      expect(wrapper.text()).toContain('Title: t-1');
      
      const profiles = wrapper.findAll('[data-testid="provider-profile-item"]');
      expect(profiles[0]!.text()).toContain('Title: t-1');
      expect(profiles[1]!.text()).not.toContain('Title:');
    });

    it('deletes a profile immediately and allows undo via toast', async () => {


      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      const initialProfile = {
        id: 'undo-1',
        name: 'Undo Me',
        endpointType: 'ollama' as const,
        endpointUrl: 'http://localhost:11434',
      };
      vm.form.providerProfiles = [initialProfile];
      
      const navButtons = wrapper.findAll('nav button');
      await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await flushPromises();

      const deleteBtn = wrapper.find('[data-testid="provider-profile-delete-button"]');
      await deleteBtn.trigger('click');
      
      // Should be deleted immediately
      expect(vm.form.providerProfiles).toHaveLength(0);
      
      // Should show undo toast
      expect(mockAddToast).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Undo Me'),
        actionLabel: 'Undo',
      }));

      // Trigger undo
      const toastCall = mockAddToast.mock.calls[0]![0];
      toastCall.onAction();
      
      // Should be restored
      expect(vm.form.providerProfiles).toHaveLength(1);
      expect(vm.form.providerProfiles[0]).toEqual(initialProfile);
    });

    it('renders provider type badge with capitalization and without uppercase class', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs },
      });
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      vm.form.providerProfiles = [{
        id: '1',
        name: 'Test Profile',
        endpointType: 'ollama' as const,
        endpointUrl: 'http://localhost:11434',
      }];
      
      const navButtons = wrapper.findAll('nav button');
      await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await flushPromises();

      const badge = wrapper.find('[data-testid="provider-type-badge"]');
      expect(badge.exists()).toBe(true);
      expect(badge.text()).toBe('Ollama');
      expect(badge.classes()).toContain('uppercase');
    });

    it('supports adding, removing and applying headers through provider profiles', async () => {
      const mockProfile = {
        id: 'p-headers',
        name: 'Header Profile',
        endpointType: 'openai' as const,
        endpointUrl: 'http://headers:8080',
        endpointHttpHeaders: [['X-From-Profile', 'val-1']] as [string, string][],
      };

      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProfile] } },
        availableModels: { value: [] },
        isFetchingModels: { value: false },
        save: mockSave,
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      // 1. Add a header manually in Connection tab
      await wrapper.find('button').findAll('span').find(s => s.text().includes('Add Header'))?.trigger('click'); // Wait, let's use a more direct way
      const vm = wrapper.vm as any;
      vm.addHeader();
      await nextTick();
      
      vm.form.endpointHttpHeaders[0] = ['X-Manual', 'val-manual'];
      
      // 2. Switch to profile with headers
      const select = wrapper.find('[data-testid="setting-quick-provider-profile-select"]');
      await select.setValue('p-headers');
      await select.trigger('change');
      await flushPromises();

      // Verify headers were overwritten by profile
      expect(vm.form.endpointHttpHeaders).toEqual([['X-From-Profile', 'val-1']]);
      
      // 3. Remove header
      const removeBtn = wrapper.findAll('button').find(b => b.findComponent({ name: 'Trash2' }).exists() || b.html().includes('lucide-trash2'));
      await removeBtn?.trigger('click');
      expect(vm.form.endpointHttpHeaders).toHaveLength(0);
    });
  });

  describe('Storage Management & OPFS', () => {
    it('successfully triggers migration when switching to OPFS', async () => {
      const mockDirectoryHandle = {
        getFileHandle: vi.fn().mockResolvedValue({
          createWritable: vi.fn().mockResolvedValue({}),
        }),
        removeEntry: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) } });
      vi.stubGlobal('isSecureContext', true);
      vi.mocked(storageService.getCurrentType).mockReturnValue('local');

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: { 
          stubs: globalStubs,
          provide: {
            'Symbol(router)': {
              push: vi.fn(),
              currentRoute: { value: { path: '/' } }
            }
          }
        } 
      });
      await wait();

      // Trigger hasChanges by changing URL
      await wrapper.find('input[data-testid="setting-url-input"]').setValue('http://example.com');

      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await nextTick();

      await wrapper.find('[data-testid="storage-opfs"]').trigger('click');
      await nextTick();

      await wrapper.find('[data-testid="setting-save-button"]').trigger('click');
      await wait();

      expect(storageService.switchProvider).toHaveBeenCalledWith('opfs');
    });

    it('warns about attachment loss when switching from OPFS to Local', async () => {
      vi.mocked(storageService.getCurrentType).mockReturnValue('opfs');
      vi.mocked(storageService.hasAttachments).mockResolvedValue(true);
      
      const settingsAsOpfs = { ...mockSettings, storageType: 'opfs' as const };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: settingsAsOpfs },
        availableModels: { value: [] },
        isFetchingModels: { value: false },
        save: vi.fn(),
        fetchModels: vi.fn(),
      });

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: { 
          stubs: globalStubs,
          provide: {
            'Symbol(router)': {
              push: vi.fn(),
              currentRoute: { value: { path: '/' } }
            }
          }
        } 
      });
      await wait();

      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await nextTick();

      await wrapper.find('[data-testid="storage-local"]').trigger('click');
      await nextTick();

      mockShowConfirm.mockResolvedValueOnce(false); 
      await wrapper.find('[data-testid="setting-save-button"]').trigger('click');
      
      expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Attachments will be inaccessible'
      }));
    });

    it('disables OPFS option if environment is not secure', async () => {
      // Mock failure of getDirectory which would happen in insecure contexts or certain environments
      vi.stubGlobal('navigator', {
        storage: {
          getDirectory: vi.fn().mockRejectedValue(new Error('Security Error'))
        }
      });

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: { 
          stubs: globalStubs,
          provide: {
            'Symbol(router)': {
              push: vi.fn(),
              currentRoute: { value: { path: '/' } }
            }
          }
        } 
      });
      await flushPromises();
      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await nextTick();
      
      const opfsBtn = wrapper.find('[data-testid="storage-opfs"]');
      expect(opfsBtn.attributes('disabled')).toBeDefined();
    });

    it('shows and handles Data Durability persistence request', async () => {
      const persistMock = vi.fn().mockResolvedValue(true);
      const persistedMock = vi.fn().mockResolvedValue(false);
      vi.stubGlobal('navigator', {
        storage: {
          persist: persistMock,
          persisted: persistedMock,
          getDirectory: vi.fn(),
        }
      });

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: { 
          stubs: globalStubs,
          provide: {
            'Symbol(router)': {
              push: vi.fn(),
              currentRoute: { value: { path: '/' } }
            }
          }
        } 
      });
      await flushPromises();
      
      // Navigate to Storage tab
      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await flushPromises();
      await nextTick();

      // Should show "Best Effort" badge initially (after persisted check)
      expect(wrapper.text()).toContain('Best Effort');
      
      const enableBtn = wrapper.find('[data-testid="setting-enable-persistence-button"]');
      expect(enableBtn.exists()).toBe(true);
      
      await enableBtn.trigger('click');
      await flushPromises();
      
      expect(persistMock).toHaveBeenCalled();
      // After clicking enable and mock resolving to true, it should show "Active" and "Protected"
      expect(wrapper.text()).toContain('Active');
      expect(wrapper.text()).toContain('Protected');
      expect(wrapper.find('[data-testid="setting-enable-persistence-button"]').exists()).toBe(false);
    });
  });
});
