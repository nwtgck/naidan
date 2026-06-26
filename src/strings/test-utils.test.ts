import { beforeEach, describe, expect, it } from 'vitest';

import {
  currentLocale,
  lazyStrings,
  registerStringBoundary,
  TEST_ONLY,
  type StringBoundaryModule,
} from './runtime';
import { ensureAllStringsForTest } from './test-utils';

function resolvedModule({ module }: {
  module: StringBoundaryModule;
}): () => Promise<StringBoundaryModule> {
  return async () => module;
}

beforeEach(() => {
  TEST_ONLY.reset();
});

describe('ensureAllStringsForTest', () => {
  it('loads every registered boundary for English', async () => {
    registerStringBoundary({
      boundaryId: 'test-english',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Type a message...' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力...' } }),
      },
    });

    await ensureAllStringsForTest({ locale: 'en' });

    expect(currentLocale.value).toBe('en');
    expect(lazyStrings.ChatInput__type_a_message()).toBe('Type a message...');
  });

  it('loads every registered boundary for Japanese', async () => {
    registerStringBoundary({
      boundaryId: 'test-japanese',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Type a message...' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力...' } }),
      },
    });

    await ensureAllStringsForTest({ locale: 'ja' });

    expect(currentLocale.value).toBe('ja');
    expect(lazyStrings.ChatInput__type_a_message()).toBe('メッセージを入力...');
  });
});
