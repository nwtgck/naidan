import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  currentLocale,
  ensureStrings,
  lazyStrings,
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
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Boundary Strings runtime', () => {

  it('falls back to English when the runtime does not expose a browser language', () => {
    vi.stubGlobal('navigator', {});
    expect(TEST_ONLY.resolveInitialLocale()).toBe('en');
    vi.unstubAllGlobals();
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
    expect(localStorage.getItem(TEST_ONLY.localeStorageKey)).toBe('ja');
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
