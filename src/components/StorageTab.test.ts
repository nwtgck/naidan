import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, nextTick, reactive } from 'vue';
import StorageTab from './StorageTab.vue';
import SettingsModal from './SettingsModal.vue';
import { useSettings } from '../composables/useSettings';
import { storageService } from '../services/storage';
import type { ProviderProfile } from '../models/types';
import { useRouter, useRoute } from 'vue-router';

// --- Mocks ---
const mockListModels = vi.fn().mockResolvedValue(['model-1']);
vi.mock('../services/llm', () => ({
  OpenAIProvider: class {
    listModels = mockListModels; 
  },
  OllamaProvider: class {
    listModels = mockListModels; 
  },
}));

const mockSave = vi.fn();
const mockUpdateProviderProfiles = vi.fn();

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(() => ({
    settings: ref({ storageType: 'local', providerProfiles: [] }),
    availableModels: ref(['model-a', 'model-b']),
    isFetchingModels: ref(false),
    save: mockSave,
    updateProviderProfiles: mockUpdateProviderProfiles,
    fetchModels: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../composables/useChat', () => ({
  useChat: vi.fn(() => ({
    deleteAllChats: vi.fn(),
    createChatGroup: vi.fn(),
    resolvedSettings: ref({ modelId: 'gpt-4', sources: { modelId: 'global' } }),
  })),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: vi.fn(),
}));

const mockShowConfirm = vi.fn();
vi.mock('../composables/useConfirm', () => ({
  useConfirm: vi.fn(() => ({
    showConfirm: mockShowConfirm,
  })),
}));

vi.mock('../composables/usePrompt', () => ({
  usePrompt: vi.fn(() => ({
    showPrompt: vi.fn(),
  })),
}));

vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(() => ({
    addToast: vi.fn(),
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
    notify: vi.fn(),
  },
}));

// --- Test Constants & Helpers ---
async function wait() {
  await new Promise(r => setTimeout(r, 100));
  await nextTick();
}

const mockSettings = {
  endpointType: 'openai',
  endpointUrl: 'http://localhost:1234/v1',
  defaultModelId: 'gpt-4',
  autoTitleEnabled: true,
  storageType: 'local',
  providerProfiles: [] as ProviderProfile[],
};

const globalStubs = {
  Activity: true, RefreshCw: true, Loader2: true, Globe: true,
  BookmarkPlus: true, Database: true, Cpu: true, Bot: true,
  Check: true, Pencil: true, Target: true, Trash: true,
  Trash2: true, X: true, CheckCircle2: true, Save: true,
  Type: true, FlaskConical: true, AlertTriangle: true, ShieldCheck: true,
  Logo: true, ImportExportModal: true, ChefHat: true, Download: true,
  Github: true, ExternalLink: true, Plus: true, Info: true,
  FileArchive: true, HardDrive: true, MessageSquareQuote: true,
  'router-link': true,
};

const globalMocks = {
  stubs: globalStubs,
};

describe('StorageTab.vue Tests', () => {
  const currentRoute = reactive({ path: '/', params: {} as any, query: {} as any });
  const mockPush = vi.fn((p) => {
    if (typeof p === 'string') {
      currentRoute.path = p;
      const segments = p.split('/');
      currentRoute.params.tab = segments[segments.length - 1];
    } else if (p && typeof p === 'object' && 'query' in p) {
      currentRoute.query = { ...currentRoute.query, ...p.query };
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('isSecureContext', true);

    currentRoute.path = '/';
    currentRoute.params = {};
    currentRoute.query = {};

    (useRouter as any).mockReturnValue({
      push: mockPush,
      replace: vi.fn(),
    });
    (useRoute as any).mockReturnValue(currentRoute);
    
    const mockFileHandle = {
      createWritable: vi.fn().mockResolvedValue({}),
    };
    const mockDirectoryHandle = {
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal('navigator', {
      storage: { 
        getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle),
        persist: vi.fn().mockResolvedValue(true),
        persisted: vi.fn().mockResolvedValue(false),
      },
    });

    vi.mocked(storageService.getCurrentType).mockReturnValue('local');

    mockSave.mockImplementation(async (patch) => {
      const currentType = storageService.getCurrentType();
      if (patch.storageType && patch.storageType !== currentType) {
        await storageService.switchProvider(patch.storageType);
      }
    });

    vi.mocked(useSettings).mockReturnValue({
      settings: ref(JSON.parse(JSON.stringify(mockSettings))),
      availableModels: ref([]),
      isFetchingModels: ref(false),
      save: mockSave,
      updateProviderProfiles: vi.fn(),
      fetchModels: vi.fn().mockResolvedValue([]),
    } as any);
  });

  describe('Storage Management & OPFS', () => {
    it('successfully triggers migration when switching to OPFS', async () => {
      vi.mocked(storageService.getCurrentType).mockReturnValue('local');
                      
      const mockFileHandle = { createWritable: vi.fn().mockResolvedValue({}) };
      const mockDirectoryHandle = {
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
        removeEntry: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('navigator', {
        storage: { getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) }
      });
                
      // Ensure useSettings.save will call switchProvider
      vi.mocked(useSettings).mockReturnValue({
        settings: ref({ ...mockSettings, storageType: 'local' }),
        availableModels: ref([]),
        isFetchingModels: ref(false),
        save: mockSave, 
        updateProviderProfiles: vi.fn(),
        fetchModels: vi.fn().mockResolvedValue([]),
      } as any);
                
      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: globalMocks
      });
      await wait();
                
      // Trigger hasChanges by changing URL to enable Save
      await wrapper.find('input[data-testid="setting-url-input"]').setValue('http://example.com');
      await wait();
                
      const storageTab = wrapper.findAll('button').find(b => b.text().toLowerCase().includes('storage'));
      await storageTab?.trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
      await wait();
                
      mockShowConfirm.mockResolvedValue(true); 
                      
      await wrapper.find('[data-testid="storage-opfs"]').trigger('click');
      await flushPromises();
      await wait();
                
      expect(storageService.switchProvider).toHaveBeenCalledWith('opfs');
    });
    it('warns about attachment loss when switching from OPFS to Local', async () => {
      vi.mocked(storageService.getCurrentType).mockReturnValue('opfs');
      vi.mocked(storageService.hasAttachments).mockResolvedValue(true);
      
      const settingsAsOpfs = { ...mockSettings, storageType: 'opfs' as const };
      vi.mocked(useSettings).mockReturnValue({
        settings: ref(settingsAsOpfs),
        availableModels: ref([]),
        isFetchingModels: ref(false),
        save: mockSave,
        updateProviderProfiles: vi.fn(),
        fetchModels: vi.fn().mockResolvedValue([]),
      } as any);

      const wrapper = mount(SettingsModal, { 
        props: { isOpen: true }, 
        global: globalMocks
      });
      await wait();

      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
      await nextTick();

      mockShowConfirm.mockResolvedValueOnce(false); // Cancel migration warning
      await wrapper.find('[data-testid="storage-local"]').trigger('click');
      await flushPromises();
      
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
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
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
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
      
      // Navigate to Storage tab
      await wrapper.find('[data-testid="tab-storage"]').trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
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
    
  describe('Direct StorageTab.vue tests', () => {
    it('renders storage providers and highlights active one', async () => {
      const wrapper = mount(StorageTab, {
        props: { storageType: 'local' },
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
    
      const localBtn = wrapper.find('[data-testid="storage-local"]');
      const opfsBtn = wrapper.find('[data-testid="storage-opfs"]');
    
      expect(localBtn.classes()).toContain('border-blue-500');
      expect(opfsBtn.classes()).not.toContain('border-blue-500');
    });
    
    it('emits update:storageType after migration confirmation', async () => {
      mockShowConfirm.mockResolvedValue(true);
      const wrapper = mount(StorageTab, {
        props: { storageType: 'local' },
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
    
      await wrapper.find('[data-testid="storage-opfs"]').trigger('click');
      await flushPromises();
    
      expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Confirm Storage Switch'
      }));
      expect(wrapper.emitted('update:storageType')?.[0]).toEqual(['opfs']);
    });
    
    it('triggers clear all history and emits close', async () => {
      mockShowConfirm.mockResolvedValue(true);
      const wrapper = mount(StorageTab, {
        props: { storageType: 'local' },
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
    
      await wrapper.find('[data-testid="setting-clear-history-button"]').trigger('click');
      await flushPromises();
    
      expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Clear History'
      }));
      expect(wrapper.emitted('close')).toBeTruthy();
      expect(mockPush).toHaveBeenCalledWith('/');
    });
  });
    
  describe('SettingsModal OPFS and Error Handling (Moved)', () => {
    it('should disable OPFS option if navigator.storage is undefined', async () => {
      vi.stubGlobal('navigator', {}); 
      vi.stubGlobal('isSecureContext', true);
    
      const wrapper = mount(SettingsModal, {
        props: { isOpen: true },
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
    
      const tabs = wrapper.findAll('button');
      const storageTab = tabs.find(b => b.text().toLowerCase().includes('storage'));
      if (storageTab) await storageTab.trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
    
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
      await vi.dynamicImportSettled();
    
      const tabs = wrapper.findAll('button');
      const storageTab = tabs.find(b => b.text().toLowerCase().includes('storage'));
      if (storageTab) await storageTab.trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
    
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
      vi.stubGlobal('navigator', { 
        storage: { 
          getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) 
        } 
      });
      vi.stubGlobal('isSecureContext', true);
    
      const wrapper = mount(SettingsModal, {
        props: { isOpen: true },
        global: globalMocks
      });
      await flushPromises();
      await vi.dynamicImportSettled();
      
      const storageTab = wrapper.findAll('button').find(b => b.text().toLowerCase().includes('storage'));
      await storageTab?.trigger('click');
      await flushPromises();
      await vi.dynamicImportSettled();
      await wait();
    
      const opfsOption = wrapper.get('[data-testid="storage-opfs"]');
      expect(opfsOption.classes()).not.toContain('cursor-not-allowed');
      expect(opfsOption.text()).not.toContain('Unsupported');
    });

    it('should show error dialog if save/migration fails', async () => {
      vi.stubGlobal('isSecureContext', true);
      const mockDirectoryHandle = {
        getFileHandle: vi.fn().mockResolvedValue({
          createWritable: vi.fn().mockResolvedValue({}),
        }),
        removeEntry: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(mockDirectoryHandle) } });
      const error = new Error('Migration Security Error');
      const mockSaveFail = vi.fn().mockRejectedValue(error);

      vi.mocked(useSettings).mockReturnValue({
        settings: { value: { storageType: 'local', providerProfiles: [], endpointUrl: '' } } as any,
        save: mockSaveFail,
        updateProviderProfiles: vi.fn(),
        initialized: { value: true } as any,
        isOnboardingDismissed: { value: true } as any,
        onboardingDraft: { value: null } as any,
        availableModels: { value: [] } as any,
        isFetchingModels: { value: false } as any,
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
      });

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
    
      expect(mockSaveFail).toHaveBeenCalled();
      expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Save Failed',
        message: expect.stringContaining('Migration Security Error'),
      }));
    });
  });
});
