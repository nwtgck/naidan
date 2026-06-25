import { describe, expect, it } from 'vitest';
import {
  ChatGroupSchemaDto,
  ChatMetaSchemaDto,
  SettingsSchemaDto,
} from './dto';
import {
  chatGroupToDomain,
  chatGroupToDto,
  chatMetaToDomain,
  chatMetaToDto,
  settingsToDomain,
  settingsToDto,
} from './mappers';
import type { Hierarchy } from './types';

const toolConfigs = [
  { key: 'builtin.calculator', status: 'enabled' },
  { key: 'builtin.choices', status: 'disabled' },
  { key: 'builtin.calculator', status: 'disabled' },
  {
    key: 'builtin.wesh',
    status: 'enabled',
    naidanSysfs: {
      accessScope: 'main_chats',
    },
  },
] as const;

describe('experimental tool config DTO', () => {
  it('persists required status values under chat meta experimental storage', () => {
    const dto = ChatMetaSchemaDto.parse({
      id: 'chat-1',
      title: 'Chat 1',
      updatedAt: 2,
      createdAt: 1,
      experimental: { toolConfigs },
    });

    const domain = chatMetaToDomain({ dto });
    expect(domain.toolConfigs).toEqual(toolConfigs);
    expect(chatMetaToDto({ domain }).experimental?.toolConfigs).toEqual(toolConfigs);
  });

  it('does not accept legacy tool config entries without status', () => {
    const dto = ChatMetaSchemaDto.parse({
      id: 'chat-1',
      title: 'Chat 1',
      updatedAt: 2,
      createdAt: 1,
      experimental: {
        toolConfigs: [{ key: 'builtin.calculator' }],
      },
    });

    expect(dto.experimental?.toolConfigs).toBeUndefined();
    expect(chatMetaToDomain({ dto }).toolConfigs).toBeUndefined();
  });

  it('round-trips chat group tool overrides', () => {
    const dto = ChatGroupSchemaDto.parse({
      id: 'group-1',
      name: 'Group 1',
      isCollapsed: false,
      updatedAt: 1,
      experimental: { toolConfigs },
    });
    const hierarchy: Hierarchy = { items: [] };
    const domain = chatGroupToDomain({ dto, hierarchy, chatMetas: [] });

    expect(domain.toolConfigs).toEqual(toolConfigs);
    expect(chatGroupToDto({ domain }).experimental?.toolConfigs).toEqual(toolConfigs);
  });

  it('round-trips global tool configs in settings', () => {
    const dto = SettingsSchemaDto.parse({
      endpoint: { type: 'openai', url: 'http://localhost', httpHeaders: undefined },
      autoTitleEnabled: true,
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      experimental: {
        toolConfigPersistence: 'enabled',
        toolConfigs,
      },
    });
    const domain = settingsToDomain({ dto });

    expect(domain.experimental?.toolConfigs).toEqual(toolConfigs);
    expect(settingsToDto({ domain }).experimental?.toolConfigs).toEqual(toolConfigs);
  });
});
