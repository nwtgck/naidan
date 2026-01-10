import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useSampleChat } from '../composables/useSampleChat';
import { storageService } from '../services/storage';
import * as llm from '../services/llm';

// Mock composables
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

// Mock storage service
vi.mock('../services/storage', () => ({
  storageService: {
    clearAll: vi.fn(),
  },
}));

// Mock LLM providers
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

describe('SettingsModal.vue', () => {
  const mockSave = vi.fn();
  const mockCreateSampleChat = vi.fn();
  const mockSettings = {
    endpointType: 'openai',
    endpointUrl: 'http://localhost:1234/v1',
    defaultModelId: 'gpt-4',
    autoTitleEnabled: true,
    storageType: 'local',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock useSettings return value
    (useSettings as unknown as Mock).mockReturnValue({
      settings: { value: mockSettings },
      save: mockSave,
    });

    // Mock useChat return value
    (useChat as unknown as Mock).mockReturnValue({});

    // Mock useSampleChat return value
    (useSampleChat as unknown as Mock).mockReturnValue({
      createSampleChat: mockCreateSampleChat,
    });

    // Mock window.confirm and window.location.reload
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('location', { reload: vi.fn() });
  });

  it('renders settings values correctly when opened', async () => {
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    expect((urlInput.element as HTMLInputElement).value).toBe('http://localhost:1234/v1');
    
    const providerSelect = wrapper.find('[data-testid="setting-provider-select"]');
    expect((providerSelect.element as HTMLSelectElement).value).toBe('openai');
  });

  it('fetches models when refresh button is clicked', async () => {
    const mockListModels = vi.fn().mockResolvedValue(['new-model-1', 'new-model-2']);
    (llm.OpenAIProvider as unknown as Mock).mockImplementation(function() {
      return { listModels: mockListModels };
    });

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    await wrapper.find('[data-testid="setting-refresh-models"]').trigger('click');
    await flushPromises();

    expect(mockListModels).toHaveBeenCalledWith('http://localhost:1234/v1');
    
    const options = wrapper.find('[data-testid="setting-model-select"]').findAll('option');
    expect(options.some(opt => opt.text() === 'new-model-1')).toBe(true);
  });

  it('calls save when Save Changes is clicked', async () => {
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    await wrapper.find('[data-testid="setting-url-input"]').setValue('http://new-url:8080');
    await wrapper.find('[data-testid="setting-save-button"]').trigger('click');

    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: 'http://new-url:8080',
    }));
    expect(wrapper.emitted()).toHaveProperty('close');
  });

  it('calls storageService.clearAll and reloads when Reset All App Data is clicked', async () => {
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    await wrapper.find('[data-testid="setting-reset-data-button"]').trigger('click');
    
    expect(window.confirm).toHaveBeenCalled();
    expect(storageService.clearAll).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('calls createSampleChat when the button is clicked', async () => {
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    await wrapper.find('[data-testid="setting-create-sample-button"]').trigger('click');
    
    expect(mockCreateSampleChat).toHaveBeenCalled();
    expect(wrapper.emitted()).toHaveProperty('close');
  });

  it('shows confirmation when closing with unsaved changes', async () => {
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    // Change something
    await wrapper.find('[data-testid="setting-url-input"]').setValue('http://changed-url');
    
    // Try to cancel
    await wrapper.find('[data-testid="setting-cancel-button"]').trigger('click');
    
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved changes'));
    expect(wrapper.emitted()).toHaveProperty('close');
  });

  it('does not close if confirmation is rejected', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    await wrapper.find('[data-testid="setting-url-input"]').setValue('http://changed-url');
    await wrapper.find('[data-testid="setting-cancel-button"]').trigger('click');
    
    expect(window.confirm).toHaveBeenCalled();
    expect(wrapper.emitted()).not.toHaveProperty('close');
  });

  it('closes without confirmation if no changes were made', async () => {
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true }
    });

    await wrapper.find('[data-testid="setting-cancel-button"]').trigger('click');
    
    expect(window.confirm).not.toHaveBeenCalled();
    expect(wrapper.emitted()).toHaveProperty('close');
  });
});
