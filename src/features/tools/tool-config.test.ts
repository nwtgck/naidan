import { describe, expect, it } from 'vitest';
import {
  builtinToolKeyForLmToolName,
  cloneToolConfigs,
  findLastToolConfigByKey,
  isLmToolEnabledInToolConfigs,
  lmToolNamesFromToolConfigs,
  resolveToolConfigForChat,
  resolveToolConfigsForChat,
  setToolStatusWithDependenciesInToolConfigs,
  setWeshAccessScopeWithDependenciesInToolConfigs,
  TEST_ONLY as TOOLS_TOOL_CONFIG_TEST_ONLY,
} from './tool-config';
import type { ToolConfig } from '@/01-models/tool';

const applicationDefaults = resolveToolConfigsForChat({
  globalToolConfigs: undefined,
  chatGroupToolConfigs: undefined,
  chatToolConfigs: undefined,
});

describe('tool config', () => {
  it('deep-clones Wesh settings when copying a tool config layer', () => {
    const original: ToolConfig[] = [{
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'main_chats' },
    }];
    const cloned = cloneToolConfigs({ toolConfigs: original });

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned?.[0]).not.toBe(original[0]);
    expect(cloned?.[0]?.key === 'builtin.wesh' && original[0]?.key === 'builtin.wesh'
      ? cloned[0].naidanSysfs
      : undefined).not.toBe(original[0]?.key === 'builtin.wesh'
      ? original[0].naidanSysfs
      : undefined);
  });

  it('keeps Naidan keys separate from LM-visible tool names', () => {
    expect(TOOLS_TOOL_CONFIG_TEST_ONLY.lmToolNamesForBuiltinToolKey({ key: 'builtin.calculator' })).toEqual(['calculator']);
    expect(TOOLS_TOOL_CONFIG_TEST_ONLY.lmToolNamesForBuiltinToolKey({ key: 'builtin.choices' })).toEqual(['choices']);
    expect(TOOLS_TOOL_CONFIG_TEST_ONLY.lmToolNamesForBuiltinToolKey({ key: 'builtin.wikipedia' })).toEqual(['wikipedia_search', 'wikipedia_get_page']);
    expect(TOOLS_TOOL_CONFIG_TEST_ONLY.lmToolNamesForBuiltinToolKey({ key: 'builtin.wesh' })).toEqual(['shell_execute']);

    expect(builtinToolKeyForLmToolName({ name: 'choices' })).toBe('builtin.choices');
    expect(builtinToolKeyForLmToolName({ name: 'shell_execute' })).toBe('builtin.wesh');
  });

  it('uses the last duplicate persisted key and excludes disabled tools', () => {
    expect(lmToolNamesFromToolConfigs({
      toolConfigs: [
        { key: 'builtin.calculator', status: 'enabled' },
        { key: 'builtin.calculator', status: 'disabled' },
        { key: 'builtin.choices', status: 'enabled' },
      ],
    })).toEqual(['choices']);
  });

  it('does not expose wikipedia when shell or sysfs does not satisfy its dependency', () => {
    const wikipedia = { key: 'builtin.wikipedia', status: 'enabled' } as const;
    const disabledShell: ToolConfig = {
      key: 'builtin.wesh',
      status: 'disabled',
      naidanSysfs: { accessScope: 'current_chat_only' },
    };
    const unmountedShell: ToolConfig = {
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'none' },
    };
    const mountedShell: ToolConfig = {
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'main_chats' },
    };

    expect(lmToolNamesFromToolConfigs({ toolConfigs: [wikipedia, disabledShell] })).toEqual([]);
    expect(lmToolNamesFromToolConfigs({ toolConfigs: [wikipedia, unmountedShell] })).toEqual(['shell_execute']);
    expect(lmToolNamesFromToolConfigs({ toolConfigs: [wikipedia, mountedShell] })).toEqual([
      'wikipedia_search',
      'wikipedia_get_page',
      'shell_execute',
    ]);
    expect(isLmToolEnabledInToolConfigs({
      toolConfigs: [wikipedia, mountedShell],
      name: 'wikipedia_search',
    })).toBe(true);
  });

  it('resolves chat, chat group, global, and application defaults in priority order', () => {
    const globalToolConfigs: ToolConfig[] = [
      { key: 'builtin.calculator', status: 'enabled' },
    ];
    const chatGroupToolConfigs: ToolConfig[] = [
      { key: 'builtin.calculator', status: 'disabled' },
    ];
    const chatToolConfigs: ToolConfig[] = [
      { key: 'builtin.calculator', status: 'enabled' },
    ];

    expect(resolveToolConfigForChat({
      key: 'builtin.calculator',
      globalToolConfigs,
      chatGroupToolConfigs,
      chatToolConfigs,
    })).toEqual({
      config: { key: 'builtin.calculator', status: 'enabled' },
      source: 'chat',
    });
    expect(resolveToolConfigForChat({
      key: 'builtin.calculator',
      globalToolConfigs,
      chatGroupToolConfigs,
      chatToolConfigs: undefined,
    }).source).toBe('chat_group');
    expect(resolveToolConfigForChat({
      key: 'builtin.calculator',
      globalToolConfigs,
      chatGroupToolConfigs: undefined,
      chatToolConfigs: undefined,
    }).source).toBe('global');
    expect(resolveToolConfigForChat({
      key: 'builtin.calculator',
      globalToolConfigs: undefined,
      chatGroupToolConfigs: undefined,
      chatToolConfigs: undefined,
    })).toEqual({
      config: { key: 'builtin.calculator', status: 'disabled' },
      source: 'application_default',
    });
  });

  it('stores explicit enabled and disabled overrides instead of removing disabled entries', () => {
    const enabled = TOOLS_TOOL_CONFIG_TEST_ONLY.setLmToolStatusInToolConfigs({
      toolConfigs: undefined,
      name: 'calculator',
      status: 'enabled',
      inheritedConfig: { key: 'builtin.calculator', status: 'disabled' },
    });
    expect(enabled).toEqual([{ key: 'builtin.calculator', status: 'enabled' }]);

    const disabled = TOOLS_TOOL_CONFIG_TEST_ONLY.setLmToolStatusInToolConfigs({
      toolConfigs: enabled,
      name: 'calculator',
      status: 'disabled',
      inheritedConfig: { key: 'builtin.calculator', status: 'enabled' },
    });
    expect(disabled).toEqual([{ key: 'builtin.calculator', status: 'disabled' }]);
  });

  it('copies inherited Wesh settings when creating an override', () => {
    const toolConfigs = TOOLS_TOOL_CONFIG_TEST_ONLY.setWeshNaidanSysfsAccessScopeInToolConfigs({
      toolConfigs: undefined,
      accessScope: 'main_chats',
      inheritedConfig: {
        key: 'builtin.wesh',
        status: 'disabled',
        naidanSysfs: { accessScope: 'current_chat_only' },
      },
      status: 'disabled',
    });

    expect(toolConfigs).toEqual([{
      key: 'builtin.wesh',
      status: 'disabled',
      naidanSysfs: { accessScope: 'main_chats' },
    }]);
  });

  it('enables wikipedia without adding a Wesh override when the parent already satisfies dependencies', () => {
    const inheritedToolConfigs: ToolConfig[] = [
      ...applicationDefaults.filter(config => config.key !== 'builtin.wesh'),
      {
        key: 'builtin.wesh',
        status: 'enabled',
        naidanSysfs: { accessScope: 'main_chats' },
      },
    ];
    const result = setToolStatusWithDependenciesInToolConfigs({
      toolConfigs: undefined,
      key: 'builtin.wikipedia',
      status: 'enabled',
      inheritedToolConfigs,
    });

    expect(result).toEqual([{ key: 'builtin.wikipedia', status: 'enabled' }]);
  });

  it('adds the required Wesh override when enabling wikipedia over disabled defaults', () => {
    const result = setToolStatusWithDependenciesInToolConfigs({
      toolConfigs: undefined,
      key: 'builtin.wikipedia',
      status: 'enabled',
      inheritedToolConfigs: applicationDefaults,
    });

    expect(findLastToolConfigByKey({
      toolConfigs: result,
      key: 'builtin.wikipedia',
    })?.status).toBe('enabled');
    expect(findLastToolConfigByKey({
      toolConfigs: result,
      key: 'builtin.wesh',
    })).toEqual({
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: { accessScope: 'current_chat_only' },
    });
  });

  it('disables wikipedia in the same layer when shell or sysfs is disabled', () => {
    const inheritedToolConfigs: ToolConfig[] = [
      ...applicationDefaults.filter(config => config.key !== 'builtin.wikipedia'),
      { key: 'builtin.wikipedia', status: 'enabled' },
    ];
    const shellDisabled = setToolStatusWithDependenciesInToolConfigs({
      toolConfigs: undefined,
      key: 'builtin.wesh',
      status: 'disabled',
      inheritedToolConfigs,
    });
    expect(findLastToolConfigByKey({
      toolConfigs: shellDisabled,
      key: 'builtin.wikipedia',
    })?.status).toBe('disabled');

    const sysfsDisabled = setWeshAccessScopeWithDependenciesInToolConfigs({
      toolConfigs: undefined,
      accessScope: 'none',
      inheritedToolConfigs,
      status: 'enabled',
    });
    expect(findLastToolConfigByKey({
      toolConfigs: sysfsDisabled,
      key: 'builtin.wikipedia',
    })?.status).toBe('disabled');
  });
});
