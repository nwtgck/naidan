import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import SettingsModal from './SettingsModal.vue';
import { useRoute, useRouter } from 'vue-router';

const mockIsFeatureEnabled = vi.fn();

vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: mockIsFeatureEnabled,
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({
      endpointType: 'openai',
      endpointUrl: 'http://localhost:1234/v1',
      endpointHttpHeaders: [],
      defaultModelId: 'model-1',
      titleModelId: 'model-1',
      autoTitleEnabled: true,
      systemPrompt: undefined,
      lmParameters: {},
      storageType: 'local',
      providerProfiles: [],
    }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    createChatGroup: vi.fn(),
  }),
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

vi.mock('@/composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn(),
  }),
}));

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: vi.fn(),
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

vi.mock('lucide-vue-next', () => ({
  XIcon: { template: '<span>X</span>' },
  GlobeIcon: { template: '<span>Globe</span>' },
  DatabaseIcon: { template: '<span>Database</span>' },
  Settings2Icon: { template: '<span>Settings2</span>' },
  BookmarkPlusIcon: { template: '<span>BookmarkPlus</span>' },
  CpuIcon: { template: '<span>Cpu</span>' },
  InfoIcon: { template: '<span>Info</span>' },
  ChefHatIcon: { template: '<span>ChefHat</span>' },
  DownloadIcon: { template: '<span>Download</span>' },
  BrainCircuitIcon: { template: '<span>BrainCircuit</span>' },
  FileIcon: { template: '<span>File</span>' },
  FolderIcon: { template: '<span>Folder</span>' },
}));

describe('SettingsModal feature flags', () => {
  const route = reactive({
    path: '/settings/connection',
    params: {} as { tab?: string },
    query: {} as Record<string, string>,
  });

  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
    (useRoute as unknown as ReturnType<typeof vi.fn>).mockReturnValue(route);
    (useRouter as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      push: vi.fn(),
    });
  });

  it('hides the volumes tab by default', () => {
    mockIsFeatureEnabled.mockImplementation(({ feature }: { feature: string }) => feature !== 'volume');

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: {
        stubs: {
          ThemeToggle: true,
          ConnectionTab: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="tab-volumes"]').exists()).toBe(false);
  });

  it('shows the volumes tab when the feature flag is enabled', () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const wrapper = mount(SettingsModal, {
      props: { isOpen: true },
      global: {
        stubs: {
          ThemeToggle: true,
          ConnectionTab: true,
        },
      },
    });

    expect(wrapper.find('[data-testid="tab-volumes"]').exists()).toBe(true);
  });
});
