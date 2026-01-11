import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useSampleChat } from '../composables/useSampleChat';
import { storageService } from '../services/storage';
import * as llm from '../services/llm';
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

vi.mock('../services/storage', () => ({
  storageService: {
    clearAll: vi.fn(),
  },
}));

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

  it('renders initial settings correctly in the Connection tab', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    expect(wrapper.text()).toContain('Endpoint Configuration');
    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    expect((urlInput.element as HTMLInputElement).value).toBe('http://localhost:1234/v1');
  });

  it('navigates between Connection, Profiles, Storage, and Developer tabs', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
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
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
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
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    const lmstudioPreset = wrapper.find('[data-testid="endpoint-preset-lm-studio"]');
    const ollamaPreset = wrapper.find('[data-testid="endpoint-preset-ollama"]');
    const llamaPreset = wrapper.find('[data-testid="endpoint-preset-llama-server-(local)"]');
    
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

  it('shows identical confirmation behavior for both "X" and "Cancel" buttons', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    await wrapper.find('[data-testid="setting-url-input"]').setValue('http://dirty');

    const closeX = wrapper.find('button[title*="Close"]');
    await closeX.trigger('click');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved changes'));
    expect(wrapper.emitted()).toHaveProperty('close');

    vi.mocked(window.confirm).mockClear();
    const cancelBtn = wrapper.find('[data-testid="setting-cancel-button"]');
    await cancelBtn.trigger('click');
    expect(window.confirm).toHaveBeenCalled();
  });

  it('performs save without closing the modal and shows feedback', async () => {
    vi.useFakeTimers();
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    await wrapper.find('[data-testid="setting-url-input"]').setValue('http://new-save-url');
    await wrapper.find('[data-testid="setting-save-button"]').trigger('click');

    expect(mockSave).toHaveBeenCalled();
    expect(wrapper.text()).toContain('Saved');
    
    vi.advanceTimersByTime(2000);
    expect(wrapper.emitted()).not.toHaveProperty('close');
    
    vi.useRealTimers();
  });

  it('handles model fetch errors gracefully', async () => {
    const mockFail = vi.fn().mockRejectedValue(new Error('API Down'));
    (llm.OpenAIProvider as unknown as Mock).mockImplementation(() => ({ listModels: mockFail }));

    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    await wrapper.find('[data-testid="setting-refresh-models"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Failed to fetch models');
  });

  it('triggers data reset after confirmation', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    await wrapper.findAll('nav button').find(b => b.text().includes('Developer'))?.trigger('click');
    await wrapper.find('[data-testid="setting-reset-data-button"]').trigger('click');
    
    expect(window.confirm).toHaveBeenCalled();
    expect(storageService.clearAll).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalled();
  });

  describe('Auto-Title Integration', () => {
    it('toggles title model selection based on auto-title checkbox', async () => {
      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
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

      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      await flushPromises();

      await wrapper.find('[data-testid="setting-save-provider-profile-button"]').trigger('click');
      
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      expect(vm.form.providerProfiles).toHaveLength(1);
      expect(vm.form.providerProfiles[0]!.name).toBe('New Test Profile');
      expect(vm.form.providerProfiles[0]!.titleModelId).toBe('special-title-model');
    });

    it('applies a profile and correctly enables the Save button (dirty check)', async () => {
      const mockProviderProfile = {
        id: 'p1',
        name: 'Ollama Profile',
        endpointType: 'ollama' as const,
        endpointUrl: 'http://ollama:11434',
        defaultModelId: 'llama3'
      };
      
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: JSON.parse(JSON.stringify(mockSettings)), providerProfiles: [mockProviderProfile] },
        save: mockSave,
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      await flushPromises();

      await wrapper.findAll('nav button').find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await wrapper.find('[data-testid="provider-profile-apply-button"]').trigger('click');
      
      // Verify form differs from initial settings (which were from mockSettings)
      const vm = wrapper.vm as unknown as { hasChanges: boolean };
      expect(vm.hasChanges).toBe(true);
      
      const saveBtn = wrapper.find('[data-testid="setting-save-button"]');
      expect(saveBtn.element.getAttribute('disabled')).toBeNull();
    });

    it('supports renaming a profile in the UI', async () => {
      const mockProviderProfile = { id: 'p1', name: 'Original Name', endpointType: 'openai' as const };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        save: mockSave,
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
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

    it('clears selection and applies profile when using the Quick Switcher', async () => {
      const mockProviderProfile = {
        id: 'quick-1',
        name: 'Quick',
        endpointType: 'ollama' as const,
        endpointUrl: 'http://quick:11434'
      };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        save: mockSave,
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      await flushPromises();

      const select = wrapper.find('[data-testid="setting-quick-provider-profile-select"]');
      await select.setValue('quick-1');
      await select.trigger('change');

      const vm = wrapper.vm as unknown as { form: { endpointUrl: string }, selectedProviderProfileId: string };
      expect(vm.form.endpointUrl).toBe('http://quick:11434');
      expect(vm.selectedProviderProfileId).toBe('');
    });

    it('deletes a profile after confirmation', async () => {
      const mockProviderProfile = { id: 'p1', name: 'Delete Me', endpointType: 'openai' as const };
      (useSettings as unknown as Mock).mockReturnValue({
        settings: { value: { ...mockSettings, providerProfiles: [mockProviderProfile] } },
        save: mockSave,
      });

      const wrapper = mount(SettingsModal, { props: { isOpen: true } });
      await flushPromises();

      await wrapper.findAll('nav button').find(b => b.text().includes('Provider Profiles'))?.trigger('click');
      await wrapper.find('[data-testid="provider-profile-delete-button"]').trigger('click');
      
      expect(window.confirm).toHaveBeenCalled();
      const vm = wrapper.vm as unknown as { form: { providerProfiles: ProviderProfile[] } };
      expect(vm.form.providerProfiles).toHaveLength(0);
    });
  });
});