import type {
  BuiltinToolKey,
  LmToolName,
  ToolConfig,
  ToolConfigStatus,
  WeshToolConfig,
} from '@/services/tools/types';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';

export const BUILTIN_TOOL_KEYS = [
  'builtin.calculator',
  'builtin.choices',
  'builtin.wikipedia',
  'builtin.wesh',
] as const satisfies readonly BuiltinToolKey[];

export type ToolConfigSource =
  | 'application_default'
  | 'global'
  | 'chat_group'
  | 'chat';

export type ResolvedToolConfig = {
  config: ToolConfig,
  source: ToolConfigSource,
};

export function lmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.calculator' }): readonly ['calculator'];
export function lmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.choices' }): readonly ['choices'];
export function lmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.wikipedia' }): readonly ['wikipedia_search', 'wikipedia_get_page'];
export function lmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.wesh' }): readonly ['shell_execute'];
export function lmToolNamesForBuiltinToolKey({ key }: { key: BuiltinToolKey }): readonly LmToolName[];
export function lmToolNamesForBuiltinToolKey({
  key,
}: {
  key: BuiltinToolKey,
}): readonly LmToolName[] {
  switch (key) {
  case 'builtin.calculator':
    return ['calculator'];
  case 'builtin.choices':
    return ['choices'];
  case 'builtin.wikipedia':
    return ['wikipedia_search', 'wikipedia_get_page'];
  case 'builtin.wesh':
    return ['shell_execute'];
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}

export function builtinToolKeyForLmToolName({
  name,
}: {
  name: LmToolName,
}): BuiltinToolKey {
  switch (name) {
  case 'calculator':
    return 'builtin.calculator';
  case 'choices':
    return 'builtin.choices';
  case 'wikipedia_search':
  case 'wikipedia_get_page':
    return 'builtin.wikipedia';
  case 'shell_execute':
    return 'builtin.wesh';
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled LM tool name: ${_ex}`);
  }
  }
}

export function isLmToolName(name: string): name is LmToolName {
  switch (name) {
  case 'calculator':
  case 'choices':
  case 'wikipedia_search':
  case 'wikipedia_get_page':
  case 'shell_execute':
    return true;
  default:
    return false;
  }
}

export function createDefaultWeshToolConfig({
  accessScope,
  status,
}: {
  accessScope: NaidanSysfsAccessScope,
  status: ToolConfigStatus,
}): WeshToolConfig {
  return {
    key: 'builtin.wesh',
    status,
    naidanSysfs: {
      accessScope,
    },
  };
}

export function createDefaultToolConfigForBuiltinToolKey({
  key,
  status,
}: {
  key: BuiltinToolKey,
  status: ToolConfigStatus,
}): ToolConfig {
  switch (key) {
  case 'builtin.calculator':
    return { key: 'builtin.calculator', status };
  case 'builtin.choices':
    return { key: 'builtin.choices', status };
  case 'builtin.wikipedia':
    return { key: 'builtin.wikipedia', status };
  case 'builtin.wesh':
    return createDefaultWeshToolConfig({
      accessScope: 'none',
      status,
    });
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}

export function createApplicationDefaultToolConfigForBuiltinToolKey({
  key,
}: {
  key: BuiltinToolKey,
}): ToolConfig {
  return createDefaultToolConfigForBuiltinToolKey({
    key,
    status: 'disabled',
  });
}

export function findLastToolConfigByKey<TKey extends BuiltinToolKey>({
  toolConfigs,
  key,
}: {
  toolConfigs: ToolConfig[] | undefined,
  key: TKey,
}): Extract<ToolConfig, { key: TKey }> | undefined {
  return (toolConfigs ?? [])
    .filter((config): config is Extract<ToolConfig, { key: TKey }> => config.key === key)
    .at(-1);
}

export function upsertSingletonToolConfig({
  toolConfigs,
  config,
}: {
  toolConfigs: ToolConfig[] | undefined,
  config: ToolConfig,
}): ToolConfig[] {
  return [
    ...(toolConfigs ?? []).filter((toolConfig) => toolConfig.key !== config.key),
    config,
  ];
}

export function cloneToolConfigs({
  toolConfigs,
}: {
  toolConfigs: readonly ToolConfig[] | undefined,
}): ToolConfig[] | undefined {
  return toolConfigs?.map((config) => {
    switch (config.key) {
    case 'builtin.calculator':
    case 'builtin.choices':
    case 'builtin.wikipedia':
      return { ...config };
    case 'builtin.wesh':
      return {
        ...config,
        naidanSysfs: {
          ...config.naidanSysfs,
        },
      };
    default: {
      const _ex: never = config;
      throw new Error(`Unhandled tool config: ${String(_ex)}`);
    }
    }
  });
}

export function removeSingletonToolConfig({
  toolConfigs,
  key,
}: {
  toolConfigs: ToolConfig[] | undefined,
  key: BuiltinToolKey,
}): ToolConfig[] | undefined {
  const next = (toolConfigs ?? []).filter((toolConfig) => toolConfig.key !== key);
  return next.length === 0 ? undefined : next;
}

export function resolveToolConfigForChat({
  key,
  globalToolConfigs,
  chatGroupToolConfigs,
  chatToolConfigs,
}: {
  key: BuiltinToolKey,
  globalToolConfigs: ToolConfig[] | undefined,
  chatGroupToolConfigs: ToolConfig[] | undefined,
  chatToolConfigs: ToolConfig[] | undefined,
}): ResolvedToolConfig {
  const chatConfig = findLastToolConfigByKey({ toolConfigs: chatToolConfigs, key });
  if (chatConfig !== undefined) {
    return { config: chatConfig, source: 'chat' };
  }

  const chatGroupConfig = findLastToolConfigByKey({ toolConfigs: chatGroupToolConfigs, key });
  if (chatGroupConfig !== undefined) {
    return { config: chatGroupConfig, source: 'chat_group' };
  }

  const globalConfig = findLastToolConfigByKey({ toolConfigs: globalToolConfigs, key });
  if (globalConfig !== undefined) {
    return { config: globalConfig, source: 'global' };
  }

  return {
    config: createApplicationDefaultToolConfigForBuiltinToolKey({ key }),
    source: 'application_default',
  };
}

export function resolveToolConfigsForChat({
  globalToolConfigs,
  chatGroupToolConfigs,
  chatToolConfigs,
}: {
  globalToolConfigs: ToolConfig[] | undefined,
  chatGroupToolConfigs: ToolConfig[] | undefined,
  chatToolConfigs: ToolConfig[] | undefined,
}): ToolConfig[] {
  return BUILTIN_TOOL_KEYS.map((key) => resolveToolConfigForChat({
    key,
    globalToolConfigs,
    chatGroupToolConfigs,
    chatToolConfigs,
  }).config);
}

export function setBuiltinToolStatusInToolConfigs({
  toolConfigs,
  key,
  status,
  inheritedConfig,
}: {
  toolConfigs: ToolConfig[] | undefined,
  key: BuiltinToolKey,
  status: ToolConfigStatus,
  inheritedConfig: ToolConfig | undefined,
}): ToolConfig[] {
  const existing = findLastToolConfigByKey({ toolConfigs, key });
  const baseConfig = existing
    ?? (inheritedConfig?.key === key ? inheritedConfig : undefined)
    ?? createApplicationDefaultToolConfigForBuiltinToolKey({ key });

  return upsertSingletonToolConfig({
    toolConfigs,
    config: {
      ...baseConfig,
      status,
    },
  });
}

export function setLmToolStatusInToolConfigs({
  toolConfigs,
  name,
  status,
  inheritedConfig,
}: {
  toolConfigs: ToolConfig[] | undefined,
  name: LmToolName,
  status: ToolConfigStatus,
  inheritedConfig: ToolConfig | undefined,
}): ToolConfig[] {
  return setBuiltinToolStatusInToolConfigs({
    toolConfigs,
    key: builtinToolKeyForLmToolName({ name }),
    status,
    inheritedConfig,
  });
}

export function setWeshNaidanSysfsAccessScopeInToolConfigs({
  toolConfigs,
  accessScope,
  inheritedConfig,
  status,
}: {
  toolConfigs: ToolConfig[] | undefined,
  accessScope: NaidanSysfsAccessScope,
  inheritedConfig: WeshToolConfig | undefined,
  status: ToolConfigStatus,
}): ToolConfig[] {
  const existing = findLastToolConfigByKey({ toolConfigs, key: 'builtin.wesh' });
  const baseConfig = existing
    ?? inheritedConfig
    ?? createDefaultWeshToolConfig({
      accessScope: 'none',
      status,
    });

  return upsertSingletonToolConfig({
    toolConfigs,
    config: {
      ...baseConfig,
      status,
      naidanSysfs: {
        accessScope,
      },
    },
  });
}

function isWeshMountedAndEnabled({
  config,
}: {
  config: WeshToolConfig | undefined,
}): boolean {
  switch (config) {
  case undefined:
    return false;
  default:
    break;
  }

  switch (config.status) {
  case 'disabled':
    return false;
  case 'enabled': {
    const accessScope = config.naidanSysfs.accessScope;
    switch (accessScope) {
    case 'none':
      return false;
    case 'current_chat_only':
    case 'current_chat_with_chat_group':
    case 'main_chats':
      return true;
    default: {
      const _ex: never = accessScope;
      throw new Error(`Unhandled Wesh access scope: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = config.status;
    throw new Error(`Unhandled tool config status: ${_ex}`);
  }
  }
}

export function toolConfigStatusForWeshAccessScope({
  accessScope,
  currentStatus,
}: {
  accessScope: NaidanSysfsAccessScope,
  currentStatus: ToolConfigStatus,
}): ToolConfigStatus {
  switch (accessScope) {
  case 'none':
    return currentStatus;
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats':
    return 'enabled';
  default: {
    const _ex: never = accessScope;
    throw new Error(`Unhandled Wesh access scope: ${_ex}`);
  }
  }
}

export function setToolStatusWithDependenciesInToolConfigs({
  toolConfigs,
  key,
  status,
  inheritedToolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined,
  key: BuiltinToolKey,
  status: ToolConfigStatus,
  inheritedToolConfigs: ToolConfig[],
}): ToolConfig[] {
  const inheritedConfig = findLastToolConfigByKey({
    toolConfigs: inheritedToolConfigs,
    key,
  });
  let nextToolConfigs = setBuiltinToolStatusInToolConfigs({
    toolConfigs,
    key,
    status,
    inheritedConfig,
  });

  switch (key) {
  case 'builtin.calculator':
  case 'builtin.choices':
    return nextToolConfigs;
  case 'builtin.wikipedia': {
    switch (status) {
    case 'disabled':
      return nextToolConfigs;
    case 'enabled':
      break;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled tool config status: ${_ex}`);
    }
    }

    const inheritedWesh = findLastToolConfigByKey({
      toolConfigs: inheritedToolConfigs,
      key: 'builtin.wesh',
    });
    const currentWesh = findLastToolConfigByKey({
      toolConfigs,
      key: 'builtin.wesh',
    }) ?? inheritedWesh;

    if (isWeshMountedAndEnabled({ config: currentWesh })) {
      return nextToolConfigs;
    }

    nextToolConfigs = setBuiltinToolStatusInToolConfigs({
      toolConfigs: nextToolConfigs,
      key: 'builtin.wesh',
      status: 'enabled',
      inheritedConfig: inheritedWesh,
    });
    const effectiveWesh = findLastToolConfigByKey({
      toolConfigs: nextToolConfigs,
      key: 'builtin.wesh',
    });
    if (isWeshMountedAndEnabled({ config: effectiveWesh })) {
      return nextToolConfigs;
    }
    return setWeshNaidanSysfsAccessScopeInToolConfigs({
      toolConfigs: nextToolConfigs,
      accessScope: 'current_chat_only',
      inheritedConfig: inheritedWesh,
      status: 'enabled',
    });
  }
  case 'builtin.wesh': {
    switch (status) {
    case 'enabled':
      return nextToolConfigs;
    case 'disabled': {
      const inheritedWikipedia = findLastToolConfigByKey({
        toolConfigs: inheritedToolConfigs,
        key: 'builtin.wikipedia',
      });
      return setBuiltinToolStatusInToolConfigs({
        toolConfigs: nextToolConfigs,
        key: 'builtin.wikipedia',
        status: 'disabled',
        inheritedConfig: inheritedWikipedia,
      });
    }
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled tool config status: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}

export function setWeshAccessScopeWithDependenciesInToolConfigs({
  toolConfigs,
  accessScope,
  inheritedToolConfigs,
  status,
}: {
  toolConfigs: ToolConfig[] | undefined,
  accessScope: NaidanSysfsAccessScope,
  inheritedToolConfigs: ToolConfig[],
  status: ToolConfigStatus,
}): ToolConfig[] {
  const inheritedWesh = findLastToolConfigByKey({
    toolConfigs: inheritedToolConfigs,
    key: 'builtin.wesh',
  });
  let nextToolConfigs = setWeshNaidanSysfsAccessScopeInToolConfigs({
    toolConfigs,
    accessScope,
    inheritedConfig: inheritedWesh,
    status,
  });

  switch (accessScope) {
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats':
    return nextToolConfigs;
  case 'none':
    break;
  default: {
    const _ex: never = accessScope;
    throw new Error(`Unhandled Wesh access scope: ${_ex}`);
  }
  }

  const inheritedWikipedia = findLastToolConfigByKey({
    toolConfigs: inheritedToolConfigs,
    key: 'builtin.wikipedia',
  });
  nextToolConfigs = setBuiltinToolStatusInToolConfigs({
    toolConfigs: nextToolConfigs,
    key: 'builtin.wikipedia',
    status: 'disabled',
    inheritedConfig: inheritedWikipedia,
  });
  return nextToolConfigs;
}

export function isBuiltinToolEnabledInToolConfigs({
  toolConfigs,
  key,
}: {
  toolConfigs: ToolConfig[] | undefined,
  key: BuiltinToolKey,
}): boolean {
  const config = findLastToolConfigByKey({ toolConfigs, key });
  const status = config?.status;
  switch (status) {
  case undefined:
  case 'disabled':
    return false;
  case 'enabled':
    break;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled tool config status: ${_ex}`);
  }
  }

  switch (key) {
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wesh':
    return true;
  case 'builtin.wikipedia': {
    const weshConfig = findLastToolConfigByKey({
      toolConfigs,
      key: 'builtin.wesh',
    });
    return isWeshMountedAndEnabled({ config: weshConfig });
  }
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}

export function isLmToolEnabledInToolConfigs({
  toolConfigs,
  name,
}: {
  toolConfigs: ToolConfig[] | undefined,
  name: LmToolName,
}): boolean {
  return isBuiltinToolEnabledInToolConfigs({
    toolConfigs,
    key: builtinToolKeyForLmToolName({ name }),
  });
}

export function lmToolNamesFromToolConfigs({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined,
}): LmToolName[] {
  const names: LmToolName[] = [];
  for (const key of BUILTIN_TOOL_KEYS) {
    if (!isBuiltinToolEnabledInToolConfigs({ toolConfigs, key })) continue;
    names.push(...lmToolNamesForBuiltinToolKey({ key }));
  }
  return names;
}
