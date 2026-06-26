import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  currentLocale,
  ensureStrings,
  lazyStrings,
  prepareLocale,
  registerStringBoundary,
  setLocale,
  TEST_ONLY,
  type StringBoundaryModule,
} from './runtime';

function resolvedModule({ module }: {
  module: StringBoundaryModule;
}): () => Promise<StringBoundaryModule> {
  return async () => module;
}

beforeEach(() => {
  TEST_ONLY.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Boundary Strings runtime', () => {

  it('falls back to English when the runtime does not expose a browser language', () => {
    vi.stubGlobal('navigator', {});
    expect(TEST_ONLY.resolveBrowserLocale()).toBe('en');
    vi.unstubAllGlobals();
  });

  it('uses the browser language without reading persistent storage', () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    expect(TEST_ONLY.resolveBrowserLocale()).toBe('ja');
    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
    vi.unstubAllGlobals();
  });

  it('does not expose message accessors through Promise or object protocol properties', async () => {
    await expect(Promise.resolve(lazyStrings)).resolves.toBe(lazyStrings);
    await expect(Promise.resolve(ensureStrings)).resolves.toBe(ensureStrings);
    expect(String(lazyStrings)).toBe('[object Object]');
    expect(JSON.stringify(lazyStrings)).toBe('{}');
  });

  it('rejects a boundary pack that omits a registered message', async () => {
    registerStringBoundary({
      boundaryId: 'incomplete-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: {} }),
        ja: resolvedModule({ module: {} }),
      },
    });

    await expect(ensureStrings.ChatInput__type_a_message()).rejects.toThrow(
      'Boundary Strings boundary incomplete-boundary did not provide message ChatInput__type_a_message for locale en.',
    );
  });

  it('loads the smallest registered boundary for a shared message', async () => {
    const largeLoader = vi.fn(resolvedModule({
      module: {
        ChatInput__type_a_message: () => 'Type a message...',
        ChatInput__cancel: () => 'Cancel',
      },
    }));
    const smallLoader = vi.fn(resolvedModule({
      module: { ChatInput__type_a_message: () => 'Type a message...' },
    }));
    registerStringBoundary({
      boundaryId: 'large-boundary',
      keys: ['ChatInput__type_a_message', 'ChatInput__cancel'],
      loaders: {
        en: largeLoader,
        ja: resolvedModule({ module: {} }),
      },
    });
    registerStringBoundary({
      boundaryId: 'small-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: smallLoader,
        ja: resolvedModule({ module: {} }),
      },
    });

    await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('Type a message...');
    expect(smallLoader).toHaveBeenCalledTimes(1);
    expect(largeLoader).not.toHaveBeenCalled();
  });

  it('returns an empty string from lazyStrings until the render message is loaded', async () => {
    const englishLoader = vi.fn(resolvedModule({
      module: { ChatInput__type_a_message: () => 'Type a message...' },
    }));
    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: englishLoader,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力...' } }),
      },
    });
    expect(lazyStrings.ChatInput__type_a_message()).toBe('');
    await vi.waitFor(() => {
      expect(englishLoader).toHaveBeenCalledTimes(1);
      expect(lazyStrings.ChatInput__type_a_message()).toBe('Type a message...');
    });
  });

  it('ensures a parameterized imperative message is loaded', async () => {
    registerStringBoundary({
      boundaryId: 'chat-input-errors',
      keys: ['ChatInput__failed_to_copy'],
      loaders: {
        en: resolvedModule({
          module: {
            ChatInput__failed_to_copy: ({ name, errorMessage }) => `Failed to copy "${name}": ${errorMessage}`,
          },
        }),
        ja: resolvedModule({
          module: {
            ChatInput__failed_to_copy: ({ name, errorMessage }) => `「${name}」をコピーできませんでした: ${errorMessage}`,
          },
        }),
      },
    });
    await expect(ensureStrings.ChatInput__failed_to_copy({
      name: 'notes',
      errorMessage: 'disk full',
    })).resolves.toBe('Failed to copy "notes": disk full');
  });

  it('warms a registered boundary during idle time', async () => {
    vi.useFakeTimers();
    const englishLoader = vi.fn(resolvedModule({
      module: { ChatInput__type_a_message: () => 'Type a message...' },
    }));
    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: englishLoader,
        ja: resolvedModule({ module: {} }),
      },
    });
    expect(englishLoader).not.toHaveBeenCalled();
    expect(TEST_ONLY.scheduledBoundaryWarmups.has('chat-input')).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(englishLoader).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.warmedBoundaryIds.has('chat-input')).toBe(true);
    expect(lazyStrings.ChatInput__type_a_message()).toBe('Type a message...');
  });

  it('updates the document language when the locale changes', async () => {
    registerStringBoundary({
      boundaryId: 'language-selector',
      keys: ['LanguageSelector__language'],
      loaders: {
        en: resolvedModule({ module: { LanguageSelector__language: () => 'Language' } }),
        ja: resolvedModule({ module: { LanguageSelector__language: () => '言語' } }),
      },
    });

    await setLocale({ locale: 'ja' });

    expect(document.documentElement.lang).toBe('ja');
  });

  it('clears loaded messages when a boundary registration is replaced', async () => {
    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Old message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古い' } }),
      },
    });
    await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('Old message');

    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'New message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '新しい' } }),
      },
    });

    await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('New message');
  });

  it('preserves a shared message from another loaded boundary when one registration is replaced', async () => {
    registerStringBoundary({
      boundaryId: 'first-chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'First message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '最初' } }),
      },
    });
    registerStringBoundary({
      boundaryId: 'second-chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Second message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '二番目' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'first-chat-input', locale: 'en' });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'second-chat-input', locale: 'en' });

    registerStringBoundary({
      boundaryId: 'first-chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Updated first message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '更新後' } }),
      },
    });

    await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('Second message');
  });

  it('loads warmed boundaries before atomically changing locale', async () => {
    vi.useFakeTimers();
    const japaneseLoader = vi.fn(resolvedModule({
      module: { LanguageSelector__language: () => '言語' },
    }));
    registerStringBoundary({
      boundaryId: 'language-selector',
      keys: ['LanguageSelector__language'],
      loaders: {
        en: resolvedModule({ module: { LanguageSelector__language: () => 'Language' } }),
        ja: japaneseLoader,
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    await setLocale({ locale: 'ja' });
    expect(japaneseLoader).toHaveBeenCalledTimes(1);
    expect(currentLocale.value).toBe('ja');
    expect(lazyStrings.LanguageSelector__language()).toBe('言語');
  });

  it('promotes scheduled warmups before preparing a locale', async () => {
    vi.useFakeTimers();
    const englishLoader = vi.fn(resolvedModule({
      module: { LanguageSelector__language: () => 'Language' },
    }));
    const japaneseLoader = vi.fn(resolvedModule({
      module: { LanguageSelector__language: () => '言語' },
    }));
    registerStringBoundary({
      boundaryId: 'language-selector',
      keys: ['LanguageSelector__language'],
      loaders: {
        en: englishLoader,
        ja: japaneseLoader,
      },
    });

    await prepareLocale({ locale: 'ja' });
    await vi.advanceTimersByTimeAsync(200);

    expect(japaneseLoader).toHaveBeenCalledTimes(1);
    expect(englishLoader).not.toHaveBeenCalled();
    expect(TEST_ONLY.scheduledBoundaryWarmups.size).toBe(0);
  });

  it('uses the latest registration when a boundary is replaced during loading', async () => {
    let resolveOld: ((module: StringBoundaryModule) => void) | undefined;
    const oldModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveOld = resolve;
    });
    const newLoader = vi.fn(resolvedModule({
      module: { ChatInput__type_a_message: () => 'New message' },
    }));
    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: async () => oldModule,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古い' } }),
      },
    });

    const messagePromise = ensureStrings.ChatInput__type_a_message();
    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: newLoader,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '新しい' } }),
      },
    });
    resolveOld?.({ ChatInput__type_a_message: () => 'Old message' });

    await expect(messagePromise).resolves.toBe('New message');
    expect(newLoader).toHaveBeenCalledTimes(1);
  });

  it('keeps a replacement boundary warmed when the obsolete warmup fails later', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectOld: ((error: Error) => void) | undefined;
    const oldModule = new Promise<StringBoundaryModule>((_resolve, reject) => {
      rejectOld = reject;
    });
    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: async () => oldModule,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古い' } }),
      },
    });
    await vi.advanceTimersByTimeAsync(200);

    registerStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'New message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '新しい' } }),
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(TEST_ONLY.warmedBoundaryIds.has('chat-input')).toBe(true);

    rejectOld?.(new Error('Obsolete warmup failed'));
    await vi.advanceTimersByTimeAsync(0);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(TEST_ONLY.warmedBoundaryIds.has('chat-input')).toBe(true);
    errorSpy.mockRestore();
  });

  it('includes a boundary registered while a locale switch is in flight', async () => {
    let resolveFirstJapanese: ((module: StringBoundaryModule) => void) | undefined;
    const firstJapaneseModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveFirstJapanese = resolve;
    });
    const secondJapaneseLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'キャンセル' },
    }));
    registerStringBoundary({
      boundaryId: 'first-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Type a message...' } }),
        ja: async () => firstJapaneseModule,
      },
    });

    const switching = setLocale({ locale: 'ja' });
    registerStringBoundary({
      boundaryId: 'second-boundary',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: secondJapaneseLoader,
      },
    });
    resolveFirstJapanese?.({ ChatInput__type_a_message: () => 'メッセージを入力...' });

    await switching;

    expect(currentLocale.value).toBe('ja');
    expect(secondJapaneseLoader).toHaveBeenCalledTimes(1);
    expect(lazyStrings.ChatInput__cancel()).toBe('キャンセル');
  });

  it('keeps the latest locale request when switches overlap', async () => {
    let resolveJapanese: ((module: StringBoundaryModule) => void) | undefined;
    const japaneseModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveJapanese = resolve;
    });
    registerStringBoundary({
      boundaryId: 'language-selector',
      keys: ['LanguageSelector__language'],
      loaders: {
        en: resolvedModule({ module: { LanguageSelector__language: () => 'Language' } }),
        ja: async () => japaneseModule,
      },
    });
    await ensureStrings.LanguageSelector__language();
    const japaneseSwitch = setLocale({ locale: 'ja' });
    const englishSwitch = setLocale({ locale: 'en' });
    await englishSwitch;
    resolveJapanese?.({ LanguageSelector__language: () => '言語' });
    await japaneseSwitch;
    expect(currentLocale.value).toBe('en');
  });
});
