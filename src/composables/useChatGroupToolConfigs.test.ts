import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { toChatGroupId } from '@/models/ids';
import type { ChatGroup, Settings } from '@/models/types';
import type { ToolConfig } from '@/services/tools/types';
import { useChatGroupToolConfigs } from './useChatGroupToolConfigs';

const mocks = vi.hoisted(() => ({ updateToolConfigs: vi.fn() }));
const settings = ref<Settings>({
  endpoint: { type: 'openai', url: '' },
  autoTitleEnabled: true,
  storageType: 'local',
  providerProfiles: [],
  mounts: [],
  experimental: {
    toolConfigPersistence: 'enabled',
    toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
  },
});
const currentChatGroup = ref<ChatGroup | null>({
  id: toChatGroupId({ raw: 'group-1' }),
  name: 'Group 1',
  isCollapsed: false,
  updatedAt: 0,
  items: [],
});


function applyLatestToolConfigUpdater({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined,
}): ToolConfig[] | undefined {
  const call = mocks.updateToolConfigs.mock.calls.at(-1)?.[0];
  if (call === undefined) {
    throw new Error('Expected a Tool Config update');
  }
  return call.updater({ toolConfigs });
}

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ settings }),
}));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({ currentChatGroup: computed(() => currentChatGroup.value) }),
}));
vi.mock('@/composables/chat/useChatGroups', () => ({
  useChatGroups: () => ({
    updateToolConfigs: mocks.updateToolConfigs,
  }),
}));

describe('useChatGroupToolConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value.experimental = {
      toolConfigPersistence: 'enabled',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    };
    currentChatGroup.value = {
      id: toChatGroupId({ raw: 'group-1' }),
      name: 'Group 1',
      isCollapsed: false,
      updatedAt: 0,
      items: [],
    };
  });

  it('inherits the Global entry when the group has no override', () => {
    const tools = useChatGroupToolConfigs();
    expect(tools.effectiveToolConfigs.value.find(config => config.key === 'builtin.calculator')).toEqual({
      key: 'builtin.calculator',
      status: 'enabled',
    });
  });

  it('writes only the explicit group override', async () => {
    const tools = useChatGroupToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'disabled' });

    expect(mocks.updateToolConfigs).toHaveBeenCalledWith({
      chatGroupId: toChatGroupId({ raw: 'group-1' }),
      updater: expect.any(Function),
    });
    expect(applyLatestToolConfigUpdater({ toolConfigs: undefined })).toEqual([
      { key: 'builtin.calculator', status: 'disabled' },
    ]);
  });

  it('enables Shell when setting a mounted visibility scope', async () => {
    const tools = useChatGroupToolConfigs();
    await tools.setWeshAccessScope({ accessScope: 'current_chat_with_chat_group' });

    expect(mocks.updateToolConfigs).toHaveBeenCalledWith({
      chatGroupId: toChatGroupId({ raw: 'group-1' }),
      updater: expect.any(Function),
    });
    expect(applyLatestToolConfigUpdater({ toolConfigs: undefined })).toEqual([{
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'current_chat_with_chat_group' },
    }]);
  });

  it('applies each change to the latest queued group layer', async () => {
    const tools = useChatGroupToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'disabled' });
    const firstCall = mocks.updateToolConfigs.mock.calls.at(-1)?.[0];
    if (firstCall === undefined) throw new Error('Expected first Tool Config update');

    await tools.setToolStatus({ key: 'builtin.choices', status: 'enabled' });
    const secondCall = mocks.updateToolConfigs.mock.calls.at(-1)?.[0];
    if (secondCall === undefined) throw new Error('Expected second Tool Config update');

    const afterFirst = firstCall.updater({ toolConfigs: undefined });
    expect(secondCall.updater({ toolConfigs: afterFirst })).toEqual([
      { key: 'builtin.calculator', status: 'disabled' },
      { key: 'builtin.choices', status: 'enabled' },
    ]);
  });

  it('does not write group settings while persistence is disabled', async () => {
    settings.value.experimental = {
      ...settings.value.experimental,
      toolConfigPersistence: 'disabled',
    };
    const tools = useChatGroupToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'disabled' });
    expect(mocks.updateToolConfigs).not.toHaveBeenCalled();
  });
});
