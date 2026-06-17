import { describe, expect, it } from 'vitest';
import {
  builtinToolKeyForLmToolName,
  lmToolNamesForBuiltinToolKey,
  lmToolNamesFromToolConfigs,
  setLmToolEnabledInToolConfigs,
  setWeshNaidanSysfsAccessScopeInToolConfigs,
} from './tool-config';

describe('tool config', () => {
  it('keeps Naidan keys separate from LM-visible tool names', () => {
    expect(lmToolNamesForBuiltinToolKey({ key: 'builtin.calculator' })).toEqual(['calculator']);
    expect(lmToolNamesForBuiltinToolKey({ key: 'builtin.choices' })).toEqual(['choices']);
    expect(lmToolNamesForBuiltinToolKey({ key: 'builtin.wikipedia' })).toEqual(['wikipedia_search', 'wikipedia_get_page']);
    expect(lmToolNamesForBuiltinToolKey({ key: 'builtin.wesh' })).toEqual(['shell_execute']);

    expect(builtinToolKeyForLmToolName({ name: 'choices' })).toBe('builtin.choices');
    expect(builtinToolKeyForLmToolName({ name: 'shell_execute' })).toBe('builtin.wesh');
  });

  it('deduplicates LM-visible names at runtime without rejecting duplicate persisted keys', () => {
    expect(lmToolNamesFromToolConfigs({
      toolConfigs: [
        { key: 'builtin.calculator' },
        { key: 'builtin.calculator' },
        { key: 'builtin.choices' },
        { key: 'builtin.wikipedia' },
      ],
    })).toEqual(['calculator', 'choices', 'wikipedia_search', 'wikipedia_get_page']);
  });

  it('uses singleton upsert semantics for current builtin tool UI writes', () => {
    const enabled = setLmToolEnabledInToolConfigs({
      toolConfigs: [{ key: 'builtin.calculator' }],
      name: 'calculator',
      enabled: true,
    });
    expect(enabled).toEqual([{ key: 'builtin.calculator' }]);

    const disabled = setLmToolEnabledInToolConfigs({
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
