import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref } from 'vue';
import LmToolsSettings from './LmToolsSettings.vue';
import type { ToolConfig } from '@/services/tools/types';

const mocks = vi.hoisted(() => ({
  setToolStatus: vi.fn(),
  resetToolToInherited: vi.fn(),
  getToolInheritanceLabel: vi.fn(),
  setNaidanSysfsAccessScope: vi.fn(),
  getActiveChatToolConfigs: vi.fn(),
  getEffectiveToolConfigsForChat: vi.fn(),
}));

const mockCurrentChat = ref({
  id: 'chat-1',
  title: 'Chat',
  root: { items: [] },
  createdAt: 1,
  updatedAt: 1,
  debugEnabled: false,
  toolConfigs: undefined as ToolConfig[] | undefined,
});
const mockSettings = ref({
  storageType: 'opfs' as const,
  mounts: [],
  experimental: {
    toolConfigPersistence: 'disabled' as 'disabled' | 'enabled',
  },
});

vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({
    currentChat: computed(() => mockCurrentChat.value),
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ settings: mockSettings }),
}));

vi.mock('@/composables/useChatTools', () => ({
  getActiveChatToolConfigs: mocks.getActiveChatToolConfigs,
  getEffectiveToolConfigsForChat: mocks.getEffectiveToolConfigsForChat,
  useChatTools: () => ({
    setToolStatus: mocks.setToolStatus,
    resetToolToInherited: mocks.resetToolToInherited,
    getToolInheritanceLabel: mocks.getToolInheritanceLabel,
  }),
}));

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    setNaidanSysfsAccessScope: mocks.setNaidanSysfsAccessScope,
  }),
}));

vi.mock('lucide-vue-next', () => ({
  InfoIcon: { template: '<span />' },
}));

const HierarchySettingsStub = defineComponent({
  name: 'ToolConfigHierarchySettings',
  props: {
    inheritanceLabelByKey: { type: Object, required: true },
  },
  emits: ['set-status', 'reset-tool', 'set-wesh-access-scope'],
  setup(props, { emit }) {
    return () => h('div', { 'data-testid': 'hierarchy-settings-stub' }, [
      h('span', { 'data-testid': 'calculator-inheritance-label' }, String(props.inheritanceLabelByKey['builtin.calculator'])),
      h('button', {
        'data-testid': 'enable-calculator',
        onClick: () => emit('set-status', { key: 'builtin.calculator', status: 'enabled' }),
      }),
      h('button', {
        'data-testid': 'reset-calculator',
        onClick: () => emit('reset-tool', { key: 'builtin.calculator' }),
      }),
      h('button', {
        'data-testid': 'set-wesh-scope',
        onClick: () => emit('set-wesh-access-scope', { accessScope: 'main_chats' }),
      }),
    ]);
  },
});

const effectiveToolConfigs: ToolConfig[] = [
  { key: 'builtin.calculator', status: 'disabled' },
  { key: 'builtin.choices', status: 'disabled' },
  { key: 'builtin.wikipedia', status: 'disabled' },
  {
    key: 'builtin.wesh',
    status: 'disabled',
    naidanSysfs: { accessScope: 'none' },
  },
];

describe('LmToolsSettings.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.value.experimental.toolConfigPersistence = 'disabled';
    mockCurrentChat.value.toolConfigs = undefined;
    mocks.getActiveChatToolConfigs.mockReturnValue(undefined);
    mocks.getEffectiveToolConfigsForChat.mockReturnValue(effectiveToolConfigs);
    mocks.getToolInheritanceLabel.mockReturnValue('Use global');
  });

  function mountSettings() {
    return mount(LmToolsSettings, {
      global: {
        stubs: {
          ToolConfigHierarchySettings: HierarchySettingsStub,
        },
      },
    });
  }

  it('shows that chat changes are runtime-only while persistence is disabled', () => {
    const wrapper = mountSettings();
    expect(wrapper.find('[data-testid="chat-tool-runtime-note"]').exists()).toBe(true);
  });

  it('hides the runtime-only note while persistence is enabled', () => {
    mockSettings.value.experimental.toolConfigPersistence = 'enabled';
    const wrapper = mountSettings();
    expect(wrapper.find('[data-testid="chat-tool-runtime-note"]').exists()).toBe(false);
  });

  it('shows Use group when the chat group has an explicit tool config', () => {
    mocks.getToolInheritanceLabel.mockReturnValue('Use group');
    const wrapper = mountSettings();
    expect(wrapper.get('[data-testid="calculator-inheritance-label"]').text()).toBe('Use group');
  });

  it('maps status changes to the chat tool API', async () => {
    const wrapper = mountSettings();
    await wrapper.get('[data-testid="enable-calculator"]').trigger('click');
    expect(mocks.setToolStatus).toHaveBeenCalledWith({
      name: 'calculator',
      status: 'enabled',
    });
  });

  it('resets a tool to its available parent instead of selecting global directly', async () => {
    const wrapper = mountSettings();
    await wrapper.get('[data-testid="reset-calculator"]').trigger('click');
    expect(mocks.resetToolToInherited).toHaveBeenCalledWith({ name: 'calculator' });
  });

  it('maps Shell visibility changes to the current chat', async () => {
    const wrapper = mountSettings();
    await wrapper.get('[data-testid="set-wesh-scope"]').trigger('click');
    expect(mocks.setNaidanSysfsAccessScope).toHaveBeenCalledWith({
      chatId: 'chat-1',
      accessScope: 'main_chats',
    });
  });
});
