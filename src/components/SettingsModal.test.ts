import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';
import { Activity } from 'lucide-vue-next';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useSampleChat } from '../composables/useSampleChat';
import { storageService } from '../services/storage';
import type { ProviderProfile } from '../models/types';

// --- Mocks ---

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

const mockAddToast = vi.fn();
vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(() => ({
    addToast: mockAddToast
  })),
}));

vi.mock('../services/storage', () => ({
  storageService: {
    clearAll: vi.fn(),
  },
}));

const mockListModels = vi.fn().mockResolvedValue(['model-1']);
vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: class { listModels = mockListModels; },
    OllamaProvider: class { listModels = mockListModels; },
  };
});

// --- Tests ---

describe('SettingsModal.vue (Tabbed Interface)', () => {
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
    AlertTriangle: true
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    (useSettings as unknown as Mock).mockReturnValue({
      settings: { value: JSON.parse(JSON.stringify(mockSettings)) },
      save: mockSave,
    });

    (useChat as unknown as Mock).mockReturnValue({});

    (useSampleChat as unknown as Mock).mockReturnValue({
      createSampleChat: mockCreateSampleChat,
    });

    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('location', { reload: vi.fn() });
  });

  describe('UI / Design Regression', () => {
    it('positions the close button correctly in the top-right corner', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs }
      });
      await flushPromises();
      
      const closeBtn = wrapper.find('[data-testid="setting-close-x"]');
      expect(closeBtn.classes()).toContain('absolute');
      expect(closeBtn.classes()).toContain('top-4');
      expect(closeBtn.classes()).toContain('right-4');
    });

    it('uses the Activity icon for the connection check button', async () => {
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs }
      });
      await flushPromises();
      
      const checkBtn = wrapper.find('[data-testid="setting-check-connection"]');
      expect(checkBtn.findComponent(Activity).exists()).toBe(true);
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
      global: { stubs: globalStubs }
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
    expect(lmstudioPreset.attributes('class')).toContain('bg-indigo-600'); // Highlighted

    // Test Ollama
    await ollamaPreset.trigger('click');
    expect(vm.form.endpointType).toBe('ollama');
    expect(vm.form.endpointUrl).toBe('http://localhost:11434');
    expect(ollamaPreset.attributes('class')).toContain('bg-indigo-600');
    expect(lmstudioPreset.attributes('class')).not.toContain('bg-indigo-600');

    // Test llama-server
    await llamaPreset.trigger('click');
    expect(vm.form.endpointType).toBe('openai');
    expect(vm.form.endpointUrl).toBe('http://localhost:8080/v1');
    expect(llamaPreset.attributes('class')).toContain('bg-indigo-600');
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
    expect(mockListModels).toHaveBeenCalledWith('https://remote-api.com');
    mockListModels.mockClear();

    // Test manual fetch for remote URL via Refresh Models button (next to dropdown)
    const refreshBtn = wrapper.find('[data-testid="setting-refresh-models"]');
    expect(refreshBtn.exists()).toBe(true);
    await refreshBtn.trigger('click');
    await flushPromises();
    expect(mockListModels).toHaveBeenCalledWith('https://remote-api.com');
    mockListModels.mockClear();

    // Test localhost URL (SHOULD auto-fetch)
    await urlInput.setValue('http://localhost:11434');
    await flushPromises();
    expect(mockListModels).toHaveBeenCalledWith('http://localhost:11434');
  });

  it('shows identical confirmation behavior for both "X" and "Cancel" buttons', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    await urlInput.setValue('http://new-url');

    // Test Cancel button
    await wrapper.find('[data-testid="setting-cancel-button"]').trigger('click');
    expect(vi.mocked(confirm)).toHaveBeenCalled();
    vi.mocked(confirm).mockClear();

    // Test X button
    await wrapper.find('[data-testid="setting-close-x"]').trigger('click');
    expect(vi.mocked(confirm)).toHaveBeenCalled();
  });

  it('performs save without closing the modal and shows feedback', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    await wrapper.find('[data-testid="setting-save-button"]').trigger('click');
    expect(wrapper.text()).toContain('Saved');
  });

  it('handles model fetch errors gracefully', async () => {
    mockListModels.mockRejectedValueOnce(new Error('Fetch failed'));
    
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    // Trigger manual fetch to show error
    await wrapper.find('[data-testid="setting-check-connection"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Connection failed. Check URL or provider.');
  });

  it('triggers data reset after confirmation', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
    await flushPromises();

    await wrapper.findAll('nav button').find(b => b.text().includes('Developer'))?.trigger('click');
    await wrapper.find('[data-testid="setting-reset-data-button"]').trigger('click');
    
    expect(window.confirm).toHaveBeenCalled();
    expect(storageService.clearAll).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalled();
  });

  describe('Auto-Title Integration', () => {
    it('toggles title model selection based on auto-title checkbox', async () => {
      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      const checkbox = wrapper.find('[data-testid="setting-auto-title-checkbox"]');
      const select = wrapper.find('[data-testid="setting-title-model-select"]');

      expect((checkbox.element as HTMLInputElement).checked).toBe(true);
      expect((select.element as HTMLSelectElement).disabled).toBe(false);

      await checkbox.setValue(false);
      expect((select.element as HTMLSelectElement).disabled).toBe(true);
    });
  });

  describe('Provider Profiles', () => {
    it('creates a new profile from current settings including titleModelId', async () => {
      vi.stubGlobal('prompt', vi.fn(() => 'New Test Profile'));
      
      const customSettings = { 
        ...mockSettings, 
        titleModelId: 'special-title-model',
        autoTitleEnabled: true 
      };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: customSettings },
        save: mockSave,
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      await wrapper.find('[data-testid="setting-save-provider-profile-button"]').trigger('click');
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      expect(vm.form.providerProfiles).toHaveLength(1);
      expect(vm.form.providerProfiles[0]!.name).toBe('New Test Profile');
      expect(vm.form.providerProfiles[0]!.titleModelId).toBe('special-title-model');
    });

    it('supports renaming a profile in the UI', async () => {
      const mockProviderProfile = { id: 'p1', name: 'Original Name', endpointType: 'openai' as const };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        save: mockSave,
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
        titleModelId: 'model-title'
      };
      
      // We need useSettings to return the profile in the initial state so form.value has it
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        save: mockSave,
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: globalStubs } });
      await flushPromises();

      const select = wrapper.find('[data-testid="setting-quick-provider-profile-select"]');
      await select.setValue('quick-1');
      await select.trigger('change');
      await flushPromises();

      const vm = wrapper.vm as any;
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
        save: mockSave,
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
        global: { stubs: globalStubs }
      });
      
      const vm = wrapper.vm as any;
      vm.form.providerProfiles = [
        { id: '1', name: 'With Title', endpointType: 'ollama', titleModelId: 't-1' },
        { id: '2', name: 'Without Title', endpointType: 'openai' }
      ];
      
      const navButtons = wrapper.findAll('nav button');
      await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await flushPromises();

      expect(wrapper.text()).toContain('Title: t-1');
      
      const profiles = wrapper.findAll('.group');
      expect(profiles[0]!.text()).toContain('Title: t-1');
      expect(profiles[1]!.text()).not.toContain('Title:');
    });

    it('deletes a profile immediately and allows undo via toast', async () => {


      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true },
        global: { stubs: globalStubs }
      });
      
      const vm = wrapper.vm as any;
      const initialProfile = {
        id: 'undo-1',
        name: 'Undo Me',
        endpointType: 'ollama',
        endpointUrl: 'http://localhost:11434'
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
        actionLabel: 'Undo'
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
        global: { stubs: globalStubs }
      });
      
      const vm = wrapper.vm as any;
      vm.form.providerProfiles = [{
        id: '1',
        name: 'Test Profile',
        endpointType: 'ollama',
        endpointUrl: 'http://localhost:11434'
      }];
      
      const navButtons = wrapper.findAll('nav button');
      await navButtons.find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await flushPromises();

      const badge = wrapper.find('[data-testid="provider-type-badge"]');
      expect(badge.exists()).toBe(true);
      expect(badge.text()).toBe('Ollama');
      expect(badge.classes()).not.toContain('uppercase');
    });
  });
});
