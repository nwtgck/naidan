import type { BuiltinToolKey, LlmToolName, ToolConfig, WeshToolConfig } from '@/services/tools/types';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';

export function llmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.calculator' }): readonly ['calculator'];
export function llmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.wikipedia' }): readonly ['wikipedia_search', 'wikipedia_get_page'];
export function llmToolNamesForBuiltinToolKey({ key }: { key: 'builtin.wesh' }): readonly ['shell_execute'];
export function llmToolNamesForBuiltinToolKey({ key }: { key: BuiltinToolKey }): readonly LlmToolName[];
export function llmToolNamesForBuiltinToolKey({
  key,
}: {
  key: BuiltinToolKey;
}): readonly LlmToolName[] {
  switch (key) {
  case 'builtin.calculator':
    return ['calculator'];
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

export function builtinToolKeyForLlmToolName({
  name,
}: {
  name: LlmToolName;
}): BuiltinToolKey {
  switch (name) {
  case 'calculator':
    return 'builtin.calculator';
  case 'wikipedia_search':
  case 'wikipedia_get_page':
    return 'builtin.wikipedia';
  case 'shell_execute':
    return 'builtin.wesh';
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled LLM tool name: ${_ex}`);
  }
  }
}

export function isLlmToolName(name: string): name is LlmToolName {
  switch (name) {
  case 'calculator':
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
}: {
  accessScope: NaidanSysfsAccessScope;
}): WeshToolConfig {
  return {
    key: 'builtin.wesh',
    naidanSysfs: {
      accessScope,
    },
  };
}

export function createDefaultToolConfigForBuiltinToolKey({
  key,
}: {
  key: BuiltinToolKey;
}): ToolConfig {
  switch (key) {
  case 'builtin.calculator':
    return { key: 'builtin.calculator' };
  case 'builtin.wikipedia':
    return { key: 'builtin.wikipedia' };
  case 'builtin.wesh':
    return createDefaultWeshToolConfig({ accessScope: 'none' });
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled builtin tool key: ${_ex}`);
  }
  }
}

export function findLastToolConfigByKey<TKey extends BuiltinToolKey>({
  toolConfigs,
  key,
}: {
  toolConfigs: ToolConfig[] | undefined;
  key: TKey;
}): Extract<ToolConfig, { key: TKey }> | undefined {
  return (toolConfigs ?? [])
    .filter((config): config is Extract<ToolConfig, { key: TKey }> => config.key === key)
    .at(-1);
}

export function upsertSingletonToolConfig({
  toolConfigs,
  config,
}: {
  toolConfigs: ToolConfig[] | undefined;
  config: ToolConfig;
}): ToolConfig[] {
  return [
    ...(toolConfigs ?? []).filter((toolConfig) => toolConfig.key !== config.key),
    config,
  ];
}

export function removeSingletonToolConfig({
  toolConfigs,
  key,
}: {
  toolConfigs: ToolConfig[] | undefined;
  key: BuiltinToolKey;
}): ToolConfig[] | undefined {
  const next = (toolConfigs ?? []).filter((toolConfig) => toolConfig.key !== key);
  return next.length === 0 ? undefined : next;
}

export function setBuiltinToolEnabledInToolConfigs({
  toolConfigs,
  key,
  enabled,
}: {
  toolConfigs: ToolConfig[] | undefined;
  key: BuiltinToolKey;
  enabled: boolean;
}): ToolConfig[] | undefined {
  if (!enabled) {
    return removeSingletonToolConfig({ toolConfigs, key });
  }

  const existing = findLastToolConfigByKey({ toolConfigs, key });
  return upsertSingletonToolConfig({
    toolConfigs,
    config: existing ?? createDefaultToolConfigForBuiltinToolKey({ key }),
  });
}

export function setLlmToolEnabledInToolConfigs({
  toolConfigs,
  name,
  enabled,
}: {
  toolConfigs: ToolConfig[] | undefined;
  name: LlmToolName;
  enabled: boolean;
}): ToolConfig[] | undefined {
  return setBuiltinToolEnabledInToolConfigs({
    toolConfigs,
    key: builtinToolKeyForLlmToolName({ name }),
    enabled,
  });
}

export function setWeshNaidanSysfsAccessScopeInToolConfigs({
  toolConfigs,
  accessScope,
}: {
  toolConfigs: ToolConfig[] | undefined;
  accessScope: NaidanSysfsAccessScope;
}): ToolConfig[] | undefined {
  const existing = findLastToolConfigByKey({ toolConfigs, key: 'builtin.wesh' });
  if (existing === undefined && accessScope === 'none') {
    return toolConfigs;
  }

  return upsertSingletonToolConfig({
    toolConfigs,
    config: {
      ...(existing ?? createDefaultWeshToolConfig({ accessScope: 'none' })),
      naidanSysfs: {
        accessScope,
      },
    },
  });
}

export function isBuiltinToolEnabledInToolConfigs({
  toolConfigs,
  key,
}: {
  toolConfigs: ToolConfig[] | undefined;
  key: BuiltinToolKey;
}): boolean {
  return findLastToolConfigByKey({ toolConfigs, key }) !== undefined;
}

export function isLlmToolEnabledInToolConfigs({
  toolConfigs,
  name,
}: {
  toolConfigs: ToolConfig[] | undefined;
  name: LlmToolName;
}): boolean {
  return isBuiltinToolEnabledInToolConfigs({
    toolConfigs,
    key: builtinToolKeyForLlmToolName({ name }),
  });
}

export function llmToolNamesFromToolConfigs({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined;
}): LlmToolName[] {
  const names = new Set<LlmToolName>();
  for (const toolConfig of toolConfigs ?? []) {
    for (const name of llmToolNamesForBuiltinToolKey({ key: toolConfig.key })) {
      names.add(name);
    }
  }
  return Array.from(names);
}
