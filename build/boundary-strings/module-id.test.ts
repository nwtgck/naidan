import { describe, expect, it } from 'vitest';

import { UI_LOCALES } from '../../src/01-models/ui-locale';

import {
  isSupportedSourceModuleId,
  messageKeyFromLocaleModuleId,
  normalizeModuleId,
  parseLocaleMessageModuleId,
  stripModuleQuery,
} from './module-id';

describe('Boundary Strings module IDs', () => {
  it('strips Vite queries without changing the source path', () => {
    expect(stripModuleQuery({
      moduleId: '/src/components/Example.vue?vue&type=template&lang.ts',
    })).toBe('/src/components/Example.vue');
    expect(normalizeModuleId({
      moduleId: String.raw`C:\repo\src\Example.ts?direct`,
    })).toBe('C:/repo/src/Example.ts');
  });

  it('recognizes only supported source extensions', () => {
    expect(isSupportedSourceModuleId({ moduleId: '/src/example.mts' })).toBe(true);
    expect(isSupportedSourceModuleId({ moduleId: '/src/example.vue?vue&type=script' })).toBe(true);
    expect(isSupportedSourceModuleId({ moduleId: '/src/example.json' })).toBe(false);
  });

  it.each(UI_LOCALES)('recognizes the message implementation for %s', (locale) => {
    expect(messageKeyFromLocaleModuleId({
      moduleId: `/repo/src/strings/messages/ChatInput__type_a_message/${locale}.ts?direct`,
    })).toBe('ChatInput__type_a_message');
  });

  it('extracts a key only from an exact locale message module path', () => {
    expect(messageKeyFromLocaleModuleId({
      moduleId: '/repo/src/strings/messages/ChatInput__type_a_message/en.ts?direct',
    })).toBe('ChatInput__type_a_message');
    expect(messageKeyFromLocaleModuleId({
      moduleId: '/repo/src/strings/messages/ChatInput__type_a_message/fr.ts',
    })).toBeUndefined();
    expect(messageKeyFromLocaleModuleId({
      moduleId: '/repo/src/strings/messages/ChatInput__type_a_message/en.ts/extra',
    })).toBeUndefined();
  });

  it('uses only exact locale module paths under the configured messages directory', () => {
    const messagesDirectoryPath = '/repo/src/strings/messages';
    const relative = 'ChatInput__type_a_message/zh-Hans.ts';
    expect(parseLocaleMessageModuleId({
      moduleId: `${messagesDirectoryPath}/${relative}`,
      messagesDirectoryPath,
    })).toEqual({ key: 'ChatInput__type_a_message', locale: 'zh-Hans' });
    for (const moduleId of [
      `/other/src/strings/messages/${relative}`,
      `${messagesDirectoryPath}/nested/src/strings/messages/${relative}`,
    ]) {
      expect(parseLocaleMessageModuleId({ moduleId, messagesDirectoryPath })).toBeUndefined();
    }
  });
});
