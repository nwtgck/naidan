 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { useConfirm } from '../composables/useConfirm';

// Mock dependencies
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(() => ({
    settings: { value: { storageType: 'local', providerProfiles: [] } },
    save: vi.fn(),
    availableModels: { value: [] },
    isFetchingModels: { value: false },
    fetchModels: vi.fn(),
  })),
}));
vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: () => ({ createSampleChat: vi.fn() }),
}));
vi.mock('../composables/useToast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({ showConfirm: vi.fn() })),
}));
vi.mock('../composables/usePrompt', () => ({
  usePrompt: () => ({ showPrompt: vi.fn() }),
}));
vi.mock('../services/storage', () => ({
  storageService: { clearAll: vi.fn() },
}));

describe('SettingsModal OPFS and Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('should disable OPFS option if navigator.storage is undefined', async () => {
    vi.stubGlobal('navigator', {}); 
    vi.stubGlobal('isSecureContext', true);
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
    });
    
    const tabs = wrapper.findAll('button');
    const storageTab = tabs.find(b => b.text().includes('Storage'));
    if (storageTab) await storageTab.trigger('click');
    
    const opfsOption = wrapper.find('[data-testid="storage-option-opfs"]');
    expect(opfsOption.classes()).toContain('cursor-not-allowed');
    expect(opfsOption.text()).toContain('Unsupported');
  });

  it('should disable OPFS option if not in secure context', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
    vi.stubGlobal('isSecureContext', false);
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
    });
    
    const tabs = wrapper.findAll('button');
    const storageTab = tabs.find(b => b.text().includes('Storage'));
    if (storageTab) await storageTab.trigger('click');
    
    const opfsOption = wrapper.find('[data-testid="storage-option-opfs"]');
    expect(opfsOption.classes()).toContain('cursor-not-allowed');
    expect(opfsOption.text()).toContain('Unsupported');
  });

  it('should enable OPFS option if supported and secure', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
    vi.stubGlobal('isSecureContext', true);
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
    });
    
    const tabs = wrapper.findAll('button');
    const storageTab = tabs.find(b => b.text().includes('Storage'));
    if (storageTab) await storageTab.trigger('click');
    
    const opfsOption = wrapper.find('[data-testid="storage-option-opfs"]');
    expect(opfsOption.classes()).not.toContain('cursor-not-allowed');
    expect(opfsOption.text()).not.toContain('Unsupported');
  });

  it('should show error dialog if save/migration fails', async () => {
    vi.stubGlobal('isSecureContext', true);
    const error = new Error('Migration Security Error');
    const mockSave = vi.fn().mockRejectedValue(error);
    const mockShowConfirm = vi.fn().mockResolvedValue(true);

    vi.mocked(useSettings).mockReturnValue({
      settings: { value: { storageType: 'local', providerProfiles: [], endpointUrl: '' } } as any,
      save: mockSave,
      loading: { value: false } as any,
      initialized: { value: true } as any,
      isOnboardingDismissed: { value: true } as any,
      onboardingDraft: { value: null } as any,
      availableModels: { value: [] } as any,
      isFetchingModels: { value: false } as any,
      init: vi.fn(),
      fetchModels: vi.fn(),
    });

    vi.mocked(useConfirm).mockReturnValue({
      showConfirm: mockShowConfirm,
      isConfirmOpen: { value: false } as any,
      confirmTitle: { value: '' } as any,
      confirmMessage: { value: '' } as any,
      confirmConfirmButtonText: { value: '' } as any,
      confirmCancelButtonText: { value: '' } as any,
      confirmButtonVariant: { value: 'primary' } as any,
      handleConfirm: vi.fn(),
      handleCancel: vi.fn(),
    });

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
    });

    // Simulate a change to enable save button
    (wrapper.vm as any).form.endpointUrl = 'http://new-url';
    await wrapper.vm.$nextTick();

    const saveButton = wrapper.find('[data-testid="setting-save-button"]');
    await saveButton.trigger('click');
    
    expect(mockSave).toHaveBeenCalled();
    expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Save Failed',
      message: expect.stringContaining('Migration Security Error'),
    }));
  });
});
