import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { useChat } from '../composables/useChat';
import { useSampleChat } from '../composables/useSampleChat';
import { storageService } from '../services/storage';
import * as llm from '../services/llm';

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

  it('renders initial settings correctly in the General tab', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    expect(wrapper.text()).toContain('Endpoint Configuration');
    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    expect((urlInput.element as HTMLInputElement).value).toBe('http://localhost:1234/v1');
  });

  it('navigates between General, Storage, and Developer tabs', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    const navButtons = wrapper.findAll('nav button');
    
    // Storage
    await navButtons.find(b => b.text().includes('Storage'))?.trigger('click');
    expect(wrapper.text()).toContain('Storage Management');

    // Developer
    await navButtons.find(b => b.text().includes('Developer'))?.trigger('click');
    expect(wrapper.text()).toContain('Developer Tools');
    expect(wrapper.text()).toContain('Danger Zone');
  });

  it('persists unsaved changes when switching tabs', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    const urlInput = wrapper.find('[data-testid="setting-url-input"]');
    await urlInput.setValue('http://temporary-change');

    // Switch away and back
    const navButtons = wrapper.findAll('nav button');
    await navButtons.find(b => b.text().includes('Storage'))?.trigger('click');
    await navButtons.find(b => b.text().includes('General'))?.trigger('click');

    expect((wrapper.find('[data-testid="setting-url-input"]').element as HTMLInputElement).value)
      .toBe('http://temporary-change');
  });

  it('shows identical confirmation behavior for both "X" and "Cancel" buttons', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true } });
    await flushPromises();

    // 1. Make a change
    await wrapper.find('[data-testid="setting-url-input"]').setValue('http://dirty');

    // 2. Test "X" button (Top Right)
    const closeX = wrapper.find('button[title*="Close"]');
    await closeX.trigger('click');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved changes'));
    expect(wrapper.emitted()).toHaveProperty('close'); // Mocked confirm returns true

    // 3. Reset change and test again for "Cancel" button
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
    
    // Wait and verify it stays open
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
});