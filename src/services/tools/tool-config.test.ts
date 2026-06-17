import { describe, expect, it } from 'vitest';
import {
  builtinToolKeyForLlmToolName,
  llmToolNamesForBuiltinToolKey,
  llmToolNamesFromToolConfigs,
  setLlmToolEnabledInToolConfigs,
  setWeshNaidanSysfsAccessScopeInToolConfigs,
} from './tool-config';

describe('tool config', () => {
  it('keeps Naidan keys separate from LLM-visible tool names', () => {
    expect(llmToolNamesForBuiltinToolKey({ key: 'builtin.calculator' })).toEqual(['calculator']);
    expect(llmToolNamesForBuiltinToolKey({ key: 'builtin.choices' })).toEqual(['choices']);
    expect(llmToolNamesForBuiltinToolKey({ key: 'builtin.wikipedia' })).toEqual(['wikipedia_search', 'wikipedia_get_page']);
    expect(llmToolNamesForBuiltinToolKey({ key: 'builtin.wesh' })).toEqual(['shell_execute']);

    expect(builtinToolKeyForLlmToolName({ name: 'choices' })).toBe('builtin.choices');
    expect(builtinToolKeyForLlmToolName({ name: 'shell_execute' })).toBe('builtin.wesh');
  });

  it('deduplicates LLM-visible names at runtime without rejecting duplicate persisted keys', () => {
    expect(llmToolNamesFromToolConfigs({
      toolConfigs: [
        { key: 'builtin.calculator' },
        { key: 'builtin.calculator' },
        { key: 'builtin.choices' },
        { key: 'builtin.wikipedia' },
      ],
    })).toEqual(['calculator', 'choices', 'wikipedia_search', 'wikipedia_get_page']);
  });

  it('uses singleton upsert semantics for current builtin tool UI writes', () => {
    const enabled = setLlmToolEnabledInToolConfigs({
      toolConfigs: [{ key: 'builtin.calculator' }],
      name: 'calculator',
      enabled: true,
    });
    expect(enabled).toEqual([{ key: 'builtin.calculator' }]);

    const disabled = setLlmToolEnabledInToolConfigs({
      toolConfigs: enabled,
      name: 'calculator',
      enabled: false,
    });
    expect(disabled).toBeUndefined();
  });

  it('stores Wesh sysfs preferences under the Wesh tool config', () => {
    const toolConfigs = setWeshNaidanSysfsAccessScopeInToolConfigs({
      toolConfigs: undefined,
      accessScope: 'main_chats',
    });

    expect(toolConfigs).toEqual([{
      key: 'builtin.wesh',
      naidanSysfs: {
        accessScope: 'main_chats',
      },
    }]);
  });
  it('does not create a disabled Wesh config when setting sysfs to none without an existing Wesh config', () => {
    expect(setWeshNaidanSysfsAccessScopeInToolConfigs({
      toolConfigs: undefined,
      accessScope: 'none',
    })).toBeUndefined();
  });

});
