import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { mount } from '@vue/test-utils';
import { computed, reactive, ref, nextTick } from 'vue';
import SettingsModal from './SettingsModal.vue';
import { useRoute, useRouter } from 'vue-router';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

const mockIsFeatureEnabled = vi.fn();
const mockRpcStatus = ref<'disabled' | 'enabled'>('disabled');

vi.mock('@/composables/useFeatureFlags', () => ({
  useFeatureFlags: () => ({
    isFeatureEnabled: mockIsFeatureEnabled,
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: computed(() => ({
      endpoint: {
        type: 'openai',
        url: 'http://localhost:1234/v1',
        httpHeaders: [],
      },
      defaultModelId: 'model-1',
      titleModelId: 'model-1',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      systemPrompt: undefined,
      lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
      storageType: 'local',
      providerProfiles: [],
      experimental: { naidanRpc: mockRpcStatus.value },
    })),
    availableModels: ref([]),
    isFetchingModels: ref(false),
  }),
}));

vi.mock('@/composables/useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction', () => ({
  useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction: () => ({
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

vi.mock('vue-router', async importOriginal => ({
  ...await importOriginal<typeof import('vue-router')>(),
  useRouter: vi.fn(),
  useRoute: vi.fn(),
}));

vi.mock('lucide-vue-next', () => ({
  XIcon: { template: '<span>X</span>' },
  GlobeIcon: { template: '<span>Globe</span>' },
  ChevronDownIcon: { template: '<span>ChevronDown</span>' },
  CheckIcon: { template: '<span>Check</span>' },
  DatabaseIcon: { template: '<span>Database</span>' },
  Settings2Icon: { template: '<span>Settings2</span>' },
  BookmarkPlusIcon: { template: '<span>BookmarkPlus</span>' },
  CpuIcon: { template: '<span>Cpu</span>' },
  NetworkIcon: { template: '<span>Network</span>' },
  InfoIcon: { template: '<span>Info</span>' },
  ChefHatIcon: { template: '<span>ChefHat</span>' },
  DownloadIcon: { template: '<span>Download</span>' },
  BrainCircuitIcon: { template: '<span>BrainCircuit</span>' },
  FileIcon: { template: '<span>File</span>' },
  FolderIcon: { template: '<span>Folder</span>' },
  WrenchIcon: { template: '<span>Wrench</span>' },
}));

describe('SettingsModal feature flags', () => {
  const route = reactive({
    path: '/settings/connection',
    params: {} as { tab?: string },
    query: {} as Record<string, string>,
  });

  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
    mockRpcStatus.value = 'disabled'; route.query = {}; route.params = {};
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

  it('shows Naidan RPC immediately above Developer only when explicitly enabled', async () => {
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: { ThemeToggle: true, ConnectionTab: true, NaidanRpcTab: true } } });
    expect(wrapper.find('[data-testid="tab-naidan-rpc"]').exists()).toBe(false);
    mockRpcStatus.value = 'enabled'; await nextTick();
    const tabs = wrapper.findAll('[data-testid^="tab-"]').map(tab => tab.attributes('data-testid'));
    expect(tabs.indexOf('tab-naidan-rpc')).toBe(tabs.indexOf('tab-developer') - 1);
    wrapper.unmount();
  });

  it.each(['query', 'params'] as const)('does not open the RPC tab through a disabled %s deep link', async source => {
    switch (source) {
    case 'query': route.query = { settings: 'naidan-rpc' }; break;
    case 'params': route.params = { tab: 'naidan-rpc' }; break;
    default: { const exhaustive: never = source; throw new Error(String(exhaustive)); }
    }
    const wrapper = mount(SettingsModal, { props: { isOpen: true }, global: { stubs: { ThemeToggle: true, ConnectionTab: true, NaidanRpcTab: true } } });
    expect(wrapper.findComponent({ name: 'ConnectionTab' }).exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'NaidanRpcTab' }).exists()).toBe(false);
    expect(useRouter().push).not.toHaveBeenCalled();
    mockRpcStatus.value = 'enabled'; await nextTick();
    expect(wrapper.findComponent({ name: 'ConnectionTab' }).exists()).toBe(false);
    mockRpcStatus.value = 'disabled'; await nextTick();
    expect(wrapper.findComponent({ name: 'ConnectionTab' }).exists()).toBe(true);
    wrapper.unmount();
  });

});
