import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, nextTick, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { useConfirm } from '../composables/useConfirm';

// Mock vue-router
vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

// Mock dependencies
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(() => ({
    settings: ref({ storageType: 'local', providerProfiles: [] }),
    save: vi.fn(),
    updateProviderProfiles: vi.fn(),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    fetchModels: vi.fn().mockResolvedValue([]),
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
  storageService: { 
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    clearAll: vi.fn(),
    getCurrentType: vi.fn().mockReturnValue('local'),
    hasAttachments: vi.fn(),
    switchProvider: vi.fn(),
    notify: vi.fn(),
  },
}));

describe('SettingsModal OPFS and Error Handling', () => {
  const globalMocks = {
    stubs: {
      Activity: true, RefreshCw: true, Loader2: true, Globe: true,
      BookmarkPlus: true, Database: true, Cpu: true, Bot: true,
      Check: true, Pencil: true, Target: true, Trash: true,
      Trash2: true, X: true, CheckCircle2: true, Save: true,
      Type: true, FlaskConical: true, AlertTriangle: true, ShieldCheck: true,
      Logo: true, ImportExportModal: true, ChefHat: true, Download: true,
      Github: true, ExternalLink: true, Plus: true, Info: true,
      FileArchive: true, HardDrive: true, MessageSquareQuote: true,
      TransformersJsManager: true, 
      // Do not stub tabs that are tested
      RecipeImportTab: true, DeveloperTab: true, AboutTab: true,
    },
  };

  const currentRoute = reactive({ path: '/', params: {} as any });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    currentRoute.path = '/';
    currentRoute.params = {};

    (useRouter as any).mockReturnValue({
      push: vi.fn((p) => {
        currentRoute.path = p;
        const segments = p.split('/');
        currentRoute.params.tab = segments[segments.length - 1];
      }),
      replace: vi.fn(),
    });
    (useRoute as any).mockReturnValue(currentRoute);
  });

  async function wait() {
    await new Promise(r => setTimeout(r, 100));
    await nextTick();
  }

  it('should disable OPFS option if navigator.storage is undefined', async () => {
    vi.stubGlobal('navigator', {}); 
    vi.stubGlobal('isSecureContext', true);
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: globalMocks
    });
    await flushPromises();
    
    const tabs = wrapper.findAll('button');
    const storageTab = tabs.find(b => b.text().toLowerCase().includes('storage'));
    if (storageTab) await storageTab.trigger('click');
    await wait();
    
    const opfsOption = wrapper.find('[data-testid="storage-opfs"]');
    expect(opfsOption.classes()).toContain('cursor-not-allowed');
    expect(opfsOption.text()).toContain('Unsupported');
  });

  it('should disable OPFS option if not in secure context', async () => {
    vi.stubGlobal('navigator', { 
      storage: { 
        getDirectory: vi.fn().mockRejectedValue(new Error('Security Error')) 
      } 
    });
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: globalMocks
    });
    await flushPromises();
    
    const tabs = wrapper.findAll('button');
    const storageTab = tabs.find(b => b.text().toLowerCase().includes('storage'));
    if (storageTab) await storageTab.trigger('click');
    await wait();
    
    const opfsOption = wrapper.find('[data-testid="storage-opfs"]');
    expect(opfsOption.classes()).toContain('cursor-not-allowed');
    expect(opfsOption.text()).toContain('Unsupported');
  });

  it('should enable OPFS option if supported and secure', async () => {
    const mockFileHandle = {
      createWritable: vi.fn().mockResolvedValue({}),
    };
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) } });
    vi.stubGlobal('isSecureContext', true);
    
    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: globalMocks
    });
    await flushPromises();
    
    const tabs = wrapper.findAll('button');
    const storageTab = tabs.find(b => b.text().toLowerCase().includes('storage'));
    if (storageTab) await storageTab.trigger('click');
    await wait();
    
    const opfsOption = wrapper.find('[data-testid="storage-opfs"]');
    expect(opfsOption.classes()).not.toContain('cursor-not-allowed');
    expect(opfsOption.text()).not.toContain('Unsupported');
  });

  it('should show error dialog if save/migration fails', async () => {
    vi.stubGlobal('isSecureContext', true);
    const mockFileHandle = {
      createWritable: vi.fn().mockResolvedValue({}),
    };
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) } });
    const error = new Error('Migration Security Error');
    const mockSave = vi.fn().mockRejectedValue(error);
    const mockShowConfirm = vi.fn().mockResolvedValue(true);

    vi.mocked(useSettings).mockReturnValue({
      settings: ref({ storageType: 'local', providerProfiles: [], endpointUrl: '' }),
      save: mockSave,
      updateProviderProfiles: vi.fn(),
      initialized: ref(true),
      isOnboardingDismissed: ref(true),
      onboardingDraft: ref(null),
      availableModels: ref([]),
      isFetchingModels: ref(false),
      init: vi.fn(),
      fetchModels: vi.fn().mockResolvedValue([]),
      updateGlobalModel: vi.fn(),
      updateGlobalEndpoint: vi.fn(),
      updateSystemPrompt: vi.fn(),
      updateStorageType: vi.fn(),
      setIsOnboardingDismissed: vi.fn(),
      setOnboardingDraft: vi.fn(),
      setHeavyContentAlertDismissed: vi.fn(),
      __testOnly: {
        __testOnlyReset: vi.fn(),
        __testOnlySetSettings: vi.fn(),
      }
    } as any);

    vi.mocked(useConfirm).mockReturnValue({
      showConfirm: mockShowConfirm,
      isConfirmOpen: ref(false),
      confirmTitle: ref(''),
      confirmMessage: ref(''),
      confirmConfirmButtonText: ref(''),
      confirmCancelButtonText: ref(''),
      confirmButtonVariant: ref('primary'),
      confirmIcon: ref(undefined),
      handleConfirm: vi.fn(),
      handleCancel: vi.fn(),
    } as any);

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: globalMocks
    });
    await flushPromises();

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
