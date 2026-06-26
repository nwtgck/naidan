import { describe, expect, it } from 'vitest';

import {
  isSupportedSourceModuleId,
  messageKeyFromLocaleModuleId,
  normalizeModuleId,
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
});
