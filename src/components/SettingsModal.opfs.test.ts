import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, nextTick, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import SettingsModal from './SettingsModal.vue';
import StorageTab from './StorageTab.vue';
import { useSettings } from '@/composables/useSettings';
import { useConfirm } from '@/composables/useConfirm';
import { ensureAllStringsForTest } from '@/strings/test-utils';

// Mock vue-router
vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

// Mock dependencies
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(() => ({
    settings: ref({ endpoint: { type: 'openai', url: '' }, storageType: 'local', providerProfiles: [] }),
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
      ActivityIcon: true, RefreshCwIcon: true, Loader2Icon: true, GlobeIcon: true,
      BookmarkPlusIcon: true, DatabaseIcon: true, CpuIcon: true, BotIcon: true,
      CheckIcon: true, PencilIcon: true, TargetIcon: true, TrashIcon: true,
      Trash2Icon: true, XIcon: true, CheckCircle2Icon: true, SaveIcon: true,
      TypeIcon: true, FlaskConicalIcon: true, AlertTriangleIcon: true, ShieldCheckIcon: true,
      Logo: true, ImportExportModal: true, ChefHatIcon: true, DownloadIcon: true,
      GithubIcon: true, ExternalLinkIcon: true, PlusIcon: true, InfoIcon: true,
      FileArchiveIcon: true, HardDriveIcon: true, GhostIcon: true, MessageSquareQuoteIcon: true,
      'router-link': true,

      // Do not stub tabs that are tested
      RecipeImportTab: true, DeveloperTab: true, AboutTab: true,
    },
  };

  const currentRoute = reactive({ path: '/', params: {} as any, query: {} as any });

  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    currentRoute.path = '/';
    currentRoute.params = {};
    currentRoute.query = {};

    (useRouter as any).mockReturnValue({
      push: vi.fn((p) => {
        if (typeof p === 'string') {
          currentRoute.path = p;
          const segments = p.split('/');
          currentRoute.params.tab = segments[segments.length - 1];
        } else if (p && typeof p === 'object' && 'query' in p) {
          currentRoute.query = { ...currentRoute.query, ...p.query };
        }
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
      global: {
        ...globalMocks,
        components: {
          StorageTab,
        },
      },
    });
    await flushPromises();

    await wrapper.get('[data-testid="tab-storage"]').trigger('click');
    await wait();

    const opfsOption = wrapper.get('[data-testid="storage-opfs"]');
    expect(opfsOption.classes()).toContain('cursor-not-allowed');
    expect(opfsOption.text()).toContain('Unsupported');
  });

  it('should disable OPFS option if not in secure context', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(new Error('Security Error')),
      },
    });

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: {
        ...globalMocks,
        components: {
          StorageTab,
        },
      },
    });
    await flushPromises();

    await wrapper.get('[data-testid="tab-storage"]').trigger('click');
    await wait();

    const opfsOption = wrapper.get('[data-testid="storage-opfs"]');
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
      global: {
        ...globalMocks,
        components: {
          StorageTab,
        },
      },
    });
    await flushPromises();

    await wrapper.get('[data-testid="tab-storage"]').trigger('click');
    await wait();

    const opfsOption = wrapper.get('[data-testid="storage-opfs"]');
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
      settings: ref({ storageType: 'local', providerProfiles: [], endpoint: { type: 'openai', url: '' } }),
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
      TEST_ONLY: {
        __testOnlyReset: vi.fn(),
        __testOnlySetSettings: vi.fn(),
      },
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
      global: {
        ...globalMocks,
        components: {
          StorageTab,
        },
      },
    });
    await flushPromises();

    // Simulate a change to enable save button
    (wrapper.vm as any).form.endpoint = { type: 'openai', url: 'http://new-url' };
    await wrapper.vm.$nextTick();

    const saveButton = wrapper.find('[data-testid="setting-save-button"]');
    await saveButton.trigger('click');

    expect(mockSave).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mockShowConfirm).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Save Failed',
        message: expect.stringContaining('Migration Security Error'),
      }));
    });
  });
});
