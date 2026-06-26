import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useGlobalToolConfigs } from './useGlobalToolConfigs';
import type { Settings } from '@/models/types';

const mocks = vi.hoisted(() => ({ updateExperimental: vi.fn() }));
const settings = ref<Settings>({
  endpointType: 'openai',
  autoTitleEnabled: true,
  storageType: 'local',
  providerProfiles: [],
  mounts: [],
  experimental: {
    toolConfigPersistence: 'enabled',
  },
});

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ settings, updateExperimental: mocks.updateExperimental }),
}));

describe('useGlobalToolConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value.experimental = { toolConfigPersistence: 'enabled' };
    mocks.updateExperimental.mockImplementation(async ({ updater }) => {
      settings.value = {
        ...settings.value,
        experimental: updater({ experimental: settings.value.experimental }),
      };
    });
  });

  it('uses disabled application defaults when no Global entry exists', () => {
    const tools = useGlobalToolConfigs();
    expect(tools.effectiveToolConfigs.value.every(config => config.status === 'disabled')).toBe(true);
  });

  it('persists an explicit Global status', async () => {
    const tools = useGlobalToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'enabled' });

    expect(mocks.updateExperimental).toHaveBeenCalledWith({
      updater: expect.any(Function),
    });
    expect(settings.value.experimental).toEqual({
      toolConfigPersistence: 'enabled',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    });
  });

  it('enables Shell when setting a mounted visibility scope', async () => {
    const tools = useGlobalToolConfigs();
    await tools.setWeshAccessScope({ accessScope: 'main_chats' });

    expect(settings.value.experimental).toEqual({
      toolConfigPersistence: 'enabled',
      toolConfigs: [{
        key: 'builtin.wesh',
        status: 'enabled',
        naidanSysfs: { accessScope: 'main_chats' },
      }],
    });
  });

  it('applies Tool Config changes to the latest experimental settings object', async () => {
    mocks.updateExperimental.mockImplementationOnce(async ({ updater }) => {
      settings.value = {
        ...settings.value,
        experimental: updater({
          experimental: {
            toolConfigPersistence: 'enabled',
            fakeLm: 'enabled',
            sidebarSendMessageReorder: 'move_sent_chat',
          },
        }),
      };
    });
    const tools = useGlobalToolConfigs();

    await tools.setToolStatus({ key: 'builtin.calculator', status: 'enabled' });

    expect(settings.value.experimental).toEqual({
      toolConfigPersistence: 'enabled',
      fakeLm: 'enabled',
      sidebarSendMessageReorder: 'move_sent_chat',
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    });
  });

  it('does not write Global settings while persistence is disabled', async () => {
    settings.value.experimental = { toolConfigPersistence: 'disabled' };
    const tools = useGlobalToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'enabled' });
    expect(mocks.updateExperimental).not.toHaveBeenCalled();
  });
});
