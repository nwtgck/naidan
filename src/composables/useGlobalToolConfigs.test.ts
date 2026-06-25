import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useGlobalToolConfigs } from './useGlobalToolConfigs';
import type { Settings } from '@/models/types';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
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
  useSettings: () => ({ settings, save: mocks.save }),
}));

describe('useGlobalToolConfigs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value.experimental = { toolConfigPersistence: 'enabled' };
    mocks.save.mockImplementation(async ({ patch }) => {
      settings.value = { ...settings.value, ...patch };
    });
  });

  it('uses disabled application defaults when no Global entry exists', () => {
    const tools = useGlobalToolConfigs();
    expect(tools.effectiveToolConfigs.value.every(config => config.status === 'disabled')).toBe(true);
  });

  it('persists an explicit Global status', async () => {
    const tools = useGlobalToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'enabled' });

    expect(mocks.save).toHaveBeenCalledWith({
      patch: {
        experimental: {
          toolConfigPersistence: 'enabled',
          toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
        },
      },
    });
  });

  it('enables Shell when setting a mounted visibility scope', async () => {
    const tools = useGlobalToolConfigs();
    await tools.setWeshAccessScope({ accessScope: 'main_chats' });

    expect(mocks.save).toHaveBeenCalledWith({
      patch: {
        experimental: {
          toolConfigPersistence: 'enabled',
          toolConfigs: [{
            key: 'builtin.wesh',
            status: 'enabled',
            naidanSysfs: { accessScope: 'main_chats' },
          }],
        },
      },
    });
  });

  it('does not write Global settings while persistence is disabled', async () => {
    settings.value.experimental = { toolConfigPersistence: 'disabled' };
    const tools = useGlobalToolConfigs();
    await tools.setToolStatus({ key: 'builtin.calculator', status: 'enabled' });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
