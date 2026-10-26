import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STANDALONE_PACKAGE_LOCALE_META_NAME } from '@/features/file-protocol-standalone/logic/package-locale';

import {
  currentLocale,
  ensureStrings,
  lazyStrings,
  prepareLocale,
  registerStringBoundary,
  setLocale,
  TEST_ONLY,
  type StringBoundaryLoaders,
  type StringBoundaryModule,
} from './runtime';

function resolvedModule({ module }: {
  module: StringBoundaryModule;
}): () => Promise<StringBoundaryModule> {
  return async () => module;
}

function registerTestStringBoundary({ boundaryId, keys, loaders }: {
  boundaryId: string;
  keys: readonly string[];
  loaders: Pick<StringBoundaryLoaders, 'en' | 'ja'>;
}): ReturnType<typeof registerStringBoundary> {
  return registerStringBoundary({
    boundaryId,
    keys,
    loaders: {
      en: loaders.en,
      ja: loaders.ja,
      'zh-Hans': loaders.en,
      'pt-BR': loaders.en,
      es: loaders.en,
      ko: loaders.en,
      de: loaders.en,
    },
  });
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

  it.each([
    ['zh', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-Hans-SG', 'zh-Hans'],
    ['pt', 'pt-BR'],
    ['pt-BR', 'pt-BR'],
    ['es-MX', 'es'],
    ['ko-KR', 'ko'],
    ['de-AT', 'de'],
  ] as const)('maps browser locale %s to supported locale %s', (browserLocale, expected) => {
    vi.stubGlobal('navigator', { language: browserLocale });
    expect(TEST_ONLY.resolveBrowserLocale()).toBe(expected);
    vi.unstubAllGlobals();
  });

  it.each(['jam', 'esu', 'kok', 'del', 'zh-TW', 'zh-Hant', 'pt-PT'] as const)(
    'falls back instead of confusing unsupported browser locale %s with a supported locale',
    (browserLocale) => {
      vi.stubGlobal('navigator', { language: browserLocale });
      expect(TEST_ONLY.resolveBrowserLocale()).toBe('en');
      vi.unstubAllGlobals();
    },
  );

  it('constrains locale preparation before a foreign package loader can run', async () => {
    const meta = document.createElement('meta');
    meta.name = STANDALONE_PACKAGE_LOCALE_META_NAME;
    meta.content = 'ja';
    document.head.append(meta);
    using _cleanupResource = {
      [Symbol.dispose]() {
        meta.remove();
      },
    };
    const englishLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Cancel' },
    }));
    const japaneseLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'キャンセル' },
    }));
    registerTestStringBoundary({
      boundaryId: 'package-constrained-boundary',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: englishLoader,
        ja: japaneseLoader,
      },
    });
    TEST_ONLY.usedBoundaryIds.add('package-constrained-boundary');

    expect(TEST_ONLY.resolveEffectiveLocale({ locale: 'en' })).toBe('ja');
    await setLocale({ locale: 'en' });

    expect(englishLoader).not.toHaveBeenCalled();
    expect(japaneseLoader).toHaveBeenCalledTimes(1);
    expect(currentLocale.value).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });

  it('does not expose message accessors through Promise or object protocol properties', async () => {
    await expect(Promise.resolve(lazyStrings)).resolves.toBe(lazyStrings);
    await expect(Promise.resolve(ensureStrings)).resolves.toBe(ensureStrings);
    expect(String(lazyStrings)).toBe('[object Object]');
    expect(JSON.stringify(lazyStrings)).toBe('{}');
  });

  it('reuses one accessor function per message key', () => {
    expect(lazyStrings.ChatInput__type_a_message).toBe(
      lazyStrings.ChatInput__type_a_message,
    );
    expect(ensureStrings.ChatInput__type_a_message).toBe(
      ensureStrings.ChatInput__type_a_message,
    );
  });

  it('rerenders only components that use a newly loaded message', async () => {
    let resolveMessage: ((module: StringBoundaryModule) => void) | undefined;
    let resolveCancel: ((module: StringBoundaryModule) => void) | undefined;
    const messageModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveMessage = resolve;
    });
    const cancelModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveCancel = resolve;
    });
    registerTestStringBoundary({
      boundaryId: 'message-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: async () => messageModule,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力...' } }),
      },
    });
    registerTestStringBoundary({
      boundaryId: 'cancel-boundary',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: async () => cancelModule,
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });

    let messageRenderCount = 0;
    let cancelRenderCount = 0;
    const messageWrapper = mount(defineComponent({
      name: 'MessageStringConsumer',
      setup() {
        return () => {
          messageRenderCount += 1;
          return h('span', lazyStrings.ChatInput__type_a_message());
        };
      },
    }));
    const cancelWrapper = mount(defineComponent({
      name: 'CancelStringConsumer',
      setup() {
        return () => {
          cancelRenderCount += 1;
          return h('span', lazyStrings.ChatInput__cancel());
        };
      },
    }));

    expect(messageRenderCount).toBe(1);
    expect(cancelRenderCount).toBe(1);
    resolveMessage?.({ ChatInput__type_a_message: () => 'Type a message...' });

    await vi.waitFor(() => {
      expect(messageWrapper.text()).toBe('Type a message...');
    });
    expect(messageRenderCount).toBe(2);
    expect(cancelRenderCount).toBe(1);

    resolveCancel?.({ ChatInput__cancel: () => 'Cancel' });
    await vi.waitFor(() => {
      expect(cancelWrapper.text()).toBe('Cancel');
    });
    messageWrapper.unmount();
    cancelWrapper.unmount();
  });

  it('batches multiple message additions from one boundary into one component update', async () => {
    let resolveBoundary: ((module: StringBoundaryModule) => void) | undefined;
    const boundaryModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveBoundary = resolve;
    });
    registerTestStringBoundary({
      boundaryId: 'chat-input-boundary',
      keys: ['ChatInput__type_a_message', 'ChatInput__cancel'],
      loaders: {
        en: async () => boundaryModule,
        ja: resolvedModule({
          module: {
            ChatInput__type_a_message: () => 'メッセージを入力...',
            ChatInput__cancel: () => 'キャンセル',
          },
        }),
      },
    });

    let renderCount = 0;
    const wrapper = mount(defineComponent({
      name: 'MultipleStringConsumer',
      setup() {
        return () => {
          renderCount += 1;
          return h('span', [
            lazyStrings.ChatInput__type_a_message(),
            lazyStrings.ChatInput__cancel(),
          ]);
        };
      },
    }));

    expect(renderCount).toBe(1);
    resolveBoundary?.({
      ChatInput__type_a_message: () => 'Type a message...',
      ChatInput__cancel: () => 'Cancel',
    });

    await vi.waitFor(() => {
      expect(wrapper.text()).toBe('Type a message...Cancel');
    });
    expect(renderCount).toBe(2);
    wrapper.unmount();
  });

  it('rerenders after each independently loaded message used by one component', async () => {
    let resolveMessage: ((module: StringBoundaryModule) => void) | undefined;
    let resolveCancel: ((module: StringBoundaryModule) => void) | undefined;
    const messageModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveMessage = resolve;
    });
    const cancelModule = new Promise<StringBoundaryModule>((resolve) => {
      resolveCancel = resolve;
    });
    registerTestStringBoundary({
      boundaryId: 'message-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: async () => messageModule,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力...' } }),
      },
    });
    registerTestStringBoundary({
      boundaryId: 'cancel-boundary',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: async () => cancelModule,
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });

    let renderCount = 0;
    const wrapper = mount(defineComponent({
      name: 'SplitBoundaryStringConsumer',
      setup() {
        return () => {
          renderCount += 1;
          return h('span', [
            lazyStrings.ChatInput__type_a_message(),
            lazyStrings.ChatInput__cancel(),
          ]);
        };
      },
    }));

    resolveMessage?.({ ChatInput__type_a_message: () => 'Type a message...' });
    await vi.waitFor(() => {
      expect(wrapper.text()).toBe('Type a message...');
    });
    expect(renderCount).toBe(2);

    resolveCancel?.({ ChatInput__cancel: () => 'Cancel' });
    await vi.waitFor(() => {
      expect(wrapper.text()).toBe('Type a message...Cancel');
    });
    expect(renderCount).toBe(3);
    wrapper.unmount();
  });

  it('rerenders all message consumers when the locale changes', async () => {
    registerTestStringBoundary({
      boundaryId: 'chat-input-boundary',
      keys: ['ChatInput__type_a_message', 'ChatInput__cancel'],
      loaders: {
        en: resolvedModule({
          module: {
            ChatInput__type_a_message: () => 'Type a message...',
            ChatInput__cancel: () => 'Cancel',
          },
        }),
        ja: resolvedModule({
          module: {
            ChatInput__type_a_message: () => 'メッセージを入力...',
            ChatInput__cancel: () => 'キャンセル',
          },
        }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'chat-input-boundary', locale: 'en' });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'chat-input-boundary', locale: 'ja' });

    let messageRenderCount = 0;
    let cancelRenderCount = 0;
    const messageWrapper = mount(defineComponent({
      name: 'LocalizedMessageStringConsumer',
      setup() {
        return () => {
          messageRenderCount += 1;
          return h('span', lazyStrings.ChatInput__type_a_message());
        };
      },
    }));
    const cancelWrapper = mount(defineComponent({
      name: 'LocalizedCancelStringConsumer',
      setup() {
        return () => {
          cancelRenderCount += 1;
          return h('span', lazyStrings.ChatInput__cancel());
        };
      },
    }));

    await setLocale({ locale: 'ja' });
    await vi.waitFor(() => {
      expect(messageWrapper.text()).toBe('メッセージを入力...');
      expect(cancelWrapper.text()).toBe('キャンセル');
    });
    expect(messageRenderCount).toBe(2);
    expect(cancelRenderCount).toBe(2);
    messageWrapper.unmount();
    cancelWrapper.unmount();
  });

  it('reactively replaces a loaded message after boundary re-registration', async () => {
    registerTestStringBoundary({
      boundaryId: 'chat-input-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Old message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古いメッセージ' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'chat-input-boundary', locale: 'en' });

    const wrapper = mount(defineComponent({
      name: 'ReloadedStringConsumer',
      setup() {
        return () => h('span', lazyStrings.ChatInput__type_a_message());
      },
    }));
    expect(wrapper.text()).toBe('Old message');

    registerTestStringBoundary({
      boundaryId: 'chat-input-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'New message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '新しいメッセージ' } }),
      },
    });

    await vi.waitFor(() => {
      expect(wrapper.text()).toBe('New message');
    });
    wrapper.unmount();
  });

  it('rejects a boundary pack that omits a registered message', async () => {
    registerTestStringBoundary({
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
    registerTestStringBoundary({
      boundaryId: 'large-boundary',
      keys: ['ChatInput__type_a_message', 'ChatInput__cancel'],
      loaders: {
        en: largeLoader,
        ja: resolvedModule({ module: {} }),
      },
    });
    registerTestStringBoundary({
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

  it('returns undefined from lazyStrings until the render message is loaded', async () => {
    const englishLoader = vi.fn(resolvedModule({
      module: { ChatInput__type_a_message: () => 'Type a message...' },
    }));
    registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: englishLoader,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力...' } }),
      },
    });
    expect(lazyStrings.ChatInput__type_a_message()).toBeUndefined();
    await vi.waitFor(() => {
      expect(englishLoader).toHaveBeenCalledTimes(1);
      expect(lazyStrings.ChatInput__type_a_message()).toBe('Type a message...');
    });
  });

  it('ensures a parameterized imperative message is loaded', async () => {
    registerTestStringBoundary({
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
    registerTestStringBoundary({
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
    registerTestStringBoundary({
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
    registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Old message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古い' } }),
      },
    });
    await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('Old message');

    registerTestStringBoundary({
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
    registerTestStringBoundary({
      boundaryId: 'first-chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'First message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '最初' } }),
      },
    });
    registerTestStringBoundary({
      boundaryId: 'second-chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Second message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '二番目' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'first-chat-input', locale: 'en' });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'second-chat-input', locale: 'en' });

    registerTestStringBoundary({
      boundaryId: 'first-chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Updated first message' } }),
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '更新後' } }),
      },
    });

    await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('Second message');
  });

  it('keeps outgoing template messages until the hot update has replaced their owner', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Cancel');
    const wrapper = mount(defineComponent({
      setup: () => () => h('span', lazyStrings.ChatInput__cancel()),
    }));
    try {
      TEST_ONLY.beginBoundaryUpdate();
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__type_a_message'],
        loaders: {
          en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Type a message' } }),
          ja: resolvedModule({ module: { ChatInput__type_a_message: () => 'メッセージを入力' } }),
        },
      });
      await wrapper.vm.$nextTick();
      expect(wrapper.text()).toBe('Cancel');
      expect(errorSpy).not.toHaveBeenCalled();
      wrapper.unmount();
      await TEST_ONLY.finishBoundaryUpdate();
      expect(TEST_ONLY.registries.en.ChatInput__cancel).toBeUndefined();
      await expect(ensureStrings.ChatInput__type_a_message()).resolves.toBe('Type a message');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      wrapper.unmount();
      errorSpy.mockRestore();
    }
  });

  it('releases deferred removal after a successful batch follows an update without afterUpdate', async () => {
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Cancel');
    TEST_ONLY.beginBoundaryUpdate();
    // An accept callback can throw before Vite emits afterUpdate.
    unregister();
    await nextTick();
    expect(lazyStrings.ChatInput__cancel()).toBe('Cancel');
    TEST_ONLY.beginBoundaryUpdate();
    await TEST_ONLY.finishBoundaryUpdate();
    expect(TEST_ONLY.registries.en.ChatInput__cancel).toBeUndefined();
  });

  it('cancels a scheduled warmup when its boundary is removed', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }));
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed',
      keys: ['ChatInput__cancel'],
      loaders: { en: loader, ja: loader },
    });

    unregister();
    unregister();
    await vi.advanceTimersByTimeAsync(200);
    await setLocale({ locale: 'ja' });

    expect(loader).not.toHaveBeenCalled();
    expect(TEST_ONLY.boundaryRegistrations.has('removed')).toBe(false);
    expect(TEST_ONLY.boundaryIdsByKey.has('ChatInput__cancel')).toBe(false);
    expect(TEST_ONLY.scheduledBoundaryWarmups.has('removed')).toBe(false);
    expect(TEST_ONLY.usedBoundaryIds.has('removed')).toBe(false);
    expect(TEST_ONLY.warmedBoundaryIds.has('removed')).toBe(false);
  });

  it('removes loaded messages and locale preparation membership with the boundary', async () => {
    vi.useFakeTimers();
    const english = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }));
    const japanese = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }));
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed',
      keys: ['ChatInput__cancel'],
      loaders: { en: english, ja: japanese },
    });
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Cancel');
    await vi.advanceTimersByTimeAsync(200);
    await setLocale({ locale: 'ja' });
    expect(TEST_ONLY.usedBoundaryIds.has('removed')).toBe(true);
    expect(TEST_ONLY.warmedBoundaryIds.has('removed')).toBe(true);

    unregister();
    await setLocale({ locale: 'en' });
    await setLocale({ locale: 'ja' });

    expect(TEST_ONLY.registries.en.ChatInput__cancel).toBeUndefined();
    expect(TEST_ONLY.registries.ja.ChatInput__cancel).toBeUndefined();
    expect(TEST_ONLY.loadedBoundaryModules.en.has('removed')).toBe(false);
    expect(TEST_ONLY.loadedBoundaryModules.ja.has('removed')).toBe(false);
    expect(TEST_ONLY.usedBoundaryIds.has('removed')).toBe(false);
    expect(TEST_ONLY.warmedBoundaryIds.has('removed')).toBe(false);
    expect(english).toHaveBeenCalledTimes(1);
    expect(japanese).toHaveBeenCalledTimes(1);
  });

  it('keeps a shared message from another loaded boundary after removal', async () => {
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Removed' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '削除' } }),
      },
    });
    registerTestStringBoundary({
      boundaryId: 'retained',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Retained' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '保持' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'retained', locale: 'en' });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'removed', locale: 'en' });
    unregister();

    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Retained');
    expect(TEST_ONLY.boundaryIdsByKey.get('ChatInput__cancel')).toEqual(new Set(['retained']));
  });

  it('ignores cleanup from an obsolete registration of the same boundary', async () => {
    const { unregister: unregisterOld } = registerTestStringBoundary({
      boundaryId: 'replaced',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧' } }),
      },
    });
    const { unregister: unregisterNew } = registerTestStringBoundary({
      boundaryId: 'replaced',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'New' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '新' } }),
      },
    });
    unregisterOld();
    unregisterOld();
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('New');
    expect(TEST_ONLY.boundaryRegistrations.has('replaced')).toBe(true);

    unregisterNew();
    expect(TEST_ONLY.boundaryRegistrations.has('replaced')).toBe(false);
  });

  it('finishes a locale switch without waiting for a removed boundary load', async () => {
    let completeLoad: ((module: StringBoundaryModule) => void) | undefined;
    const pending = new Promise<StringBoundaryModule>((resolve) => {
      completeLoad = resolve;
    });
    const japanese = vi.fn(async () => pending);
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: japanese,
      },
    });
    const switching = setLocale({ locale: 'ja' });
    expect(japanese).toHaveBeenCalledTimes(1);
    unregister();
    await switching;

    expect(currentLocale.value).toBe('ja');
    expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
    completeLoad?.({ ChatInput__cancel: () => 'Obsolete' });
    await pending;
    await Promise.resolve();
    expect(TEST_ONLY.registries.ja.ChatInput__cancel).toBeUndefined();
    expect(TEST_ONLY.loadedBoundaryModules.ja.has('removed')).toBe(false);
  });

  it('moves an imperative shared-key request to a remaining boundary after removal', async () => {
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'first',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: () => new Promise<StringBoundaryModule>(() => {}),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧' } }),
      },
    });
    registerTestStringBoundary({
      boundaryId: 'second',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Remaining' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '保持' } }),
      },
    });
    const message = ensureStrings.ChatInput__cancel();
    unregister();
    await expect(message).resolves.toBe('Remaining');
    expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
  });

  it('uses a replacement without waiting for an obsolete load that later fails', async () => {
    let rejectOld: ((error: Error) => void) | undefined;
    const pending = new Promise<StringBoundaryModule>((_resolve, reject) => {
      rejectOld = reject;
    });
    registerTestStringBoundary({
      boundaryId: 'replaced',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: async () => pending,
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧' } }),
      },
    });
    const message = ensureStrings.ChatInput__cancel();
    registerTestStringBoundary({
      boundaryId: 'replaced',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'New' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '新' } }),
      },
    });
    await expect(message).resolves.toBe('New');
    rejectOld?.(new Error('Obsolete loader failed'));
    await Promise.resolve();
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('New');
  });

  it('loads warmed boundaries before atomically changing locale', async () => {
    vi.useFakeTimers();
    const japaneseLoader = vi.fn(resolvedModule({
      module: { LanguageSelector__language: () => '言語' },
    }));
    registerTestStringBoundary({
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
    registerTestStringBoundary({
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
    registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: async () => oldModule,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古い' } }),
      },
    });

    const messagePromise = ensureStrings.ChatInput__type_a_message();
    registerTestStringBoundary({
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
    registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: async () => oldModule,
        ja: resolvedModule({ module: { ChatInput__type_a_message: () => '古い' } }),
      },
    });
    await vi.advanceTimersByTimeAsync(200);

    registerTestStringBoundary({
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
    registerTestStringBoundary({
      boundaryId: 'first-boundary',
      keys: ['ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__type_a_message: () => 'Type a message...' } }),
        ja: async () => firstJapaneseModule,
      },
    });

    const switching = setLocale({ locale: 'ja' });
    registerTestStringBoundary({
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
    registerTestStringBoundary({
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

  it('updates message content without recreating the consumer or resetting its local state', async () => {
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    const setup = vi.fn(() => {
      const count = ref(0);
      return () => h('button', {
        'data-testid': 'counter',
        onClick: () => count.value++,
      }, `${count.value} ${lazyStrings.ChatInput__cancel()}`);
    });
    const wrapper = mount(defineComponent({ setup }));
    try {
      await wrapper.get('[data-testid="counter"]').trigger('click');
      expect(wrapper.text()).toBe('1 Cancel');

      updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'Updated cancel' } });
      await nextTick();

      expect(wrapper.text()).toBe('1 Updated cancel');
      expect(setup).toHaveBeenCalledTimes(1);
      expect(TEST_ONLY.boundaryRegistrations.size).toBe(1);
    } finally {
      wrapper.unmount();
    }
  });

  it('updates an inactive locale without clearing another loaded locale or refetching either', async () => {
    const english = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }));
    const japanese = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }));
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: { en: english, ja: japanese },
    });
    await ensureStrings.ChatInput__cancel();
    await setLocale({ locale: 'ja' });
    await setLocale({ locale: 'en' });

    updateLocale({ locale: 'ja', module: { ChatInput__cancel: () => '取り消す' } });

    expect(lazyStrings.ChatInput__cancel()).toBe('Cancel');
    expect(TEST_ONLY.loadedBoundaryModules.en.has('chat-input')).toBe(true);
    await setLocale({ locale: 'ja' });
    expect(lazyStrings.ChatInput__cancel()).toBe('取り消す');
    expect(english).toHaveBeenCalledTimes(1);
    expect(japanese).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.usedBoundaryIds.has('chat-input')).toBe(true);
    expect(TEST_ONLY.warmedBoundaryIds.has('chat-input')).toBe(true);
  });

  it.each(['resolve', 'reject'] as const)('releases all callers before an obsolete import can %s', async (settlement) => {
    let resolveOld: ((module: StringBoundaryModule) => void) | undefined;
    let rejectOld: ((error: Error) => void) | undefined;
    const oldModule = new Promise<StringBoundaryModule>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    const english = vi.fn(async () => oldModule);
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: english,
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    const first = ensureStrings.ChatInput__cancel();
    const second = ensureStrings.ChatInput__cancel();

    updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'New cancel' } });

    await expect(first).resolves.toBe('New cancel');
    await expect(second).resolves.toBe('New cancel');
    expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
    if (settlement === 'resolve') {
      resolveOld?.({ ChatInput__cancel: () => 'Obsolete cancel' });
    } else {
      rejectOld?.(new Error('Obsolete import failed'));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(lazyStrings.ChatInput__cancel()).toBe('New cancel');
    expect(english).toHaveBeenCalledTimes(1);
  });

  it('reports a current import failure to every waiting caller without silently retrying', async () => {
    let rejectLoad: ((error: Error) => void) | undefined;
    const pending = new Promise<StringBoundaryModule>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const english = vi.fn(async () => pending);
    registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: english,
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    const first = expect(ensureStrings.ChatInput__cancel()).rejects.toThrow('Current import failed');
    const second = expect(ensureStrings.ChatInput__cancel()).rejects.toThrow('Current import failed');
    rejectLoad?.(new Error('Current import failed'));
    await first;
    await second;
    expect(english).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
  });

  it('releases only the updated locale while another locale import is still pending', async () => {
    let resolveJapanese: ((module: StringBoundaryModule) => void) | undefined;
    const japanese = vi.fn(() => new Promise<StringBoundaryModule>((resolve) => {
      resolveJapanese = resolve;
    }));
    const english = vi.fn(() => new Promise<StringBoundaryModule>(() => {}));
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: { en: english, ja: japanese },
    });
    const reading = ensureStrings.ChatInput__cancel();
    const switching = setLocale({ locale: 'ja' });
    updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'New cancel' } });
    await expect(reading).resolves.toBe('New cancel');
    expect(TEST_ONLY.loadingBoundaries.has('ja:chat-input')).toBe(true);
    expect(currentLocale.value).toBe('en');
    resolveJapanese?.({ ChatInput__cancel: () => 'キャンセル' });
    await switching;
    expect(currentLocale.value).toBe('ja');
    expect(lazyStrings.ChatInput__cancel()).toBe('キャンセル');
    expect(japanese).toHaveBeenCalledTimes(1);
  });

  it('ignores locale updates from a replaced or unregistered boundary', async () => {
    const old = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧' } }),
      },
    });
    const replacement = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Replacement' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '新' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    old.updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'Stale update' } });
    expect(lazyStrings.ChatInput__cancel()).toBe('Replacement');

    replacement.unregister();
    replacement.updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'After removal' } });
    expect(TEST_ONLY.boundaryRegistrations.size).toBe(0);
    expect(TEST_ONLY.registries.en.ChatInput__cancel).toBeUndefined();
    expect(TEST_ONLY.loadedBoundaryModules.en.size).toBe(0);
  });

  it('retains the last valid locale when an update lacks a registered message', async () => {
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'chat-input',
      keys: ['ChatInput__cancel', 'ChatInput__type_a_message'],
      loaders: {
        en: resolvedModule({
          module: {
            ChatInput__cancel: () => 'Cancel',
            ChatInput__type_a_message: () => 'Type a message',
          },
        }),
        ja: resolvedModule({
          module: {
            ChatInput__cancel: () => 'キャンセル',
            ChatInput__type_a_message: () => '入力',
          },
        }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    expect(() => updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'Partial update' } }))
      .toThrow('did not provide message ChatInput__type_a_message for locale en');
    expect(lazyStrings.ChatInput__cancel()).toBe('Cancel');
    expect(lazyStrings.ChatInput__type_a_message()).toBe('Type a message');
  });

  it('waits for the replacement pack instead of returning an outgoing rendered message', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    const completedMessage = await ensureStrings.ChatInput__cancel();
    const wrapper = mount(defineComponent({
      setup: () => () => h('span', lazyStrings.ChatInput__cancel()),
    }));
    const replacement = Promise.withResolvers<StringBoundaryModule>();
    const loader = vi.fn(() => replacement.promise);
    TEST_ONLY.beginBoundaryUpdate();
    try {
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__cancel', 'ChatInput__type_a_message'],
        loaders: { en: loader, ja: loader },
      });
      const pendingMessage = ensureStrings.ChatInput__cancel();
      expect(loader).toHaveBeenCalledTimes(1);
      expect(wrapper.text()).toBe('Old cancel');
      replacement.resolve({
        ChatInput__cancel: () => 'New cancel',
        ChatInput__type_a_message: () => 'Type a message',
      });
      await expect(pendingMessage).resolves.toBe('New cancel');
      expect(completedMessage).toBe('Old cancel');
      await nextTick();
      expect(wrapper.text()).toBe('New cancel');
    } finally {
      wrapper.unmount();
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('rejects imperative reads after removal while retaining outgoing render text', async () => {
    vi.useFakeTimers();
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    TEST_ONLY.beginBoundaryUpdate();
    try {
      unregister();
      expect(lazyStrings.ChatInput__cancel()).toBe('Cancel');
      await expect(ensureStrings.ChatInput__cancel()).rejects.toThrow(
        'Boundary Strings key ChatInput__cancel has not been registered by a loaded module.',
      );
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('uses the surviving loaded owner for imperative reads during deferred removal', async () => {
    vi.useFakeTimers();
    const retainedLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Retained cancel' },
    }));
    registerTestStringBoundary({
      boundaryId: 'retained',
      keys: ['ChatInput__cancel'],
      loaders: { en: retainedLoader, ja: retainedLoader },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'retained', locale: 'en' });
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Outgoing cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'removed', locale: 'en' });
    TEST_ONLY.beginBoundaryUpdate();
    try {
      unregister();
      expect(lazyStrings.ChatInput__cancel()).toBe('Outgoing cancel');
      await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Retained cancel');
      expect(retainedLoader).toHaveBeenCalledTimes(1);
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
    expect(lazyStrings.ChatInput__cancel()).toBe('Retained cancel');
  });

  it('reports replacement loading errors instead of returning deferred old text', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    const failure = new Error('The replacement pack failed');
    const loader = vi.fn(async () => {
      throw failure;
    });
    TEST_ONLY.beginBoundaryUpdate();
    try {
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__cancel'],
        loaders: { en: loader, ja: loader },
      });
      await expect(ensureStrings.ChatInput__cancel()).rejects.toBe(failure);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(lazyStrings.ChatInput__cancel()).toBe('Old cancel');
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('keeps completed imperative messages unchanged after a locale pack update', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }));
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: loader, ja: loader },
    });
    const completedMessage = await ensureStrings.ChatInput__cancel();
    updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'Updated cancel' } });
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Updated cancel');
    expect(completedMessage).toBe('Cancel');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('shares the replacement import between imperative calls during a hot update', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    const replacement = Promise.withResolvers<StringBoundaryModule>();
    const loader = vi.fn(() => replacement.promise);
    TEST_ONLY.beginBoundaryUpdate();
    try {
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__cancel'],
        loaders: { en: loader, ja: loader },
      });
      const first = ensureStrings.ChatInput__cancel();
      const second = ensureStrings.ChatInput__cancel();
      expect(loader).toHaveBeenCalledTimes(1);
      replacement.resolve({ ChatInput__cancel: () => 'New cancel' });
      await expect(first).resolves.toBe('New cancel');
      await expect(second).resolves.toBe('New cancel');
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('preserves the latest loaded shared message while both owners remain active', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'first',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'First cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '最初のキャンセル' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'first', locale: 'en' });
    registerTestStringBoundary({
      boundaryId: 'second',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Latest cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '最新のキャンセル' } }),
      },
    });
    await TEST_ONLY.ensureBoundaryLoaded({ boundaryId: 'second', locale: 'en' });
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Latest cancel');
    TEST_ONLY.beginBoundaryUpdate();
    try {
      await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Latest cancel');
      expect(lazyStrings.ChatInput__cancel()).toBe('Latest cancel');
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it.each(['immediate', 'deferred'] as const)(
    'rechecks a loaded imperative read after an owner replacement with %s render cleanup',
    async (cleanup) => {
      vi.useFakeTimers();
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__cancel'],
        loaders: {
          en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
          ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
        },
      });
      const completedMessage = await ensureStrings.ChatInput__cancel();
      const replacement = Promise.withResolvers<StringBoundaryModule>();
      const loader = vi.fn(() => replacement.promise);
      if (cleanup === 'deferred') {
        TEST_ONLY.beginBoundaryUpdate();
      }
      try {
        // The loaded check succeeds synchronously, but the accessor resumes later.
        const pendingMessage = ensureStrings.ChatInput__cancel();
        const result = expect(pendingMessage).resolves.toBe('New cancel');
        registerTestStringBoundary({
          boundaryId: 'owner',
          keys: ['ChatInput__cancel'],
          loaders: { en: loader, ja: loader },
        });
        replacement.resolve({ ChatInput__cancel: () => 'New cancel' });
        await result;
        expect(loader).toHaveBeenCalledTimes(1);
        expect(completedMessage).toBe('Old cancel');
      } finally {
        if (cleanup === 'deferred') {
          await TEST_ONLY.finishBoundaryUpdate();
        }
      }
    },
  );

  it('propagates the replacement failure when the owner changes after the loaded check', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    const failure = new Error('The replacement import failed');
    const loader = vi.fn(async () => {
      throw failure;
    });
    TEST_ONLY.beginBoundaryUpdate();
    try {
      const pendingMessage = ensureStrings.ChatInput__cancel();
      const result = expect(pendingMessage).rejects.toBe(failure);
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__cancel'],
        loaders: { en: loader, ja: loader },
      });
      await result;
      expect(loader).toHaveBeenCalledTimes(1);
      expect(lazyStrings.ChatInput__cancel()).toBe('Old cancel');
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('loads a surviving cold owner after removal between the loaded check and read', async () => {
    vi.useFakeTimers();
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'outgoing',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Outgoing cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    const retainedLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Retained cancel' },
    }));
    registerTestStringBoundary({
      boundaryId: 'retained',
      keys: ['ChatInput__cancel'],
      loaders: { en: retainedLoader, ja: retainedLoader },
    });
    const pendingMessage = ensureStrings.ChatInput__cancel();
    unregister();
    await expect(pendingMessage).resolves.toBe('Retained cancel');
    expect(retainedLoader).toHaveBeenCalledTimes(1);
  });

  it('rejects a loaded imperative read when its last owner disappears before consumption', async () => {
    vi.useFakeTimers();
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    TEST_ONLY.beginBoundaryUpdate();
    try {
      const pendingMessage = ensureStrings.ChatInput__cancel();
      unregister();
      await expect(pendingMessage).rejects.toThrow('Boundary Strings');
      expect(lazyStrings.ChatInput__cancel()).toBe('Cancel');
      expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('uses an in-place locale update between the loaded check and imperative consumption', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }));
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: loader, ja: loader },
    });
    await ensureStrings.ChatInput__cancel();
    const pendingMessage = ensureStrings.ChatInput__cancel();
    updateLocale({ locale: 'en', module: { ChatInput__cancel: () => 'Updated cancel' } });
    await expect(pendingMessage).resolves.toBe('Updated cancel');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('follows successive owner replacements without waiting for an abandoned import', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    const abandoned = Promise.withResolvers<StringBoundaryModule>();
    const middleLoader = vi.fn(() => abandoned.promise);
    const pendingMessage = ensureStrings.ChatInput__cancel();
    const result = expect(pendingMessage).resolves.toBe('Latest cancel');
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: middleLoader, ja: middleLoader },
    });
    // Let the waiting accessor reach the middle generation, without running warmups.
    await Promise.resolve();
    const latestLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Latest cancel' },
    }));
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: latestLoader, ja: latestLoader },
    });
    await result;
    expect(middleLoader).toHaveBeenCalledTimes(1);
    expect(latestLoader).toHaveBeenCalledTimes(1);
    abandoned.resolve({ ChatInput__cancel: () => 'Abandoned cancel' });
    await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Latest cancel');
  });

  it('waits for a boundary registered after preparation before committing the locale', async () => {
    vi.useFakeTimers();
    const japanese = Promise.withResolvers<StringBoundaryModule>();
    const loader = vi.fn(() => japanese.promise);
    const switching = setLocale({ locale: 'ja' });
    // The empty preparation resumes first; the locale-switch continuation is still queued.
    await Promise.resolve();
    registerTestStringBoundary({
      boundaryId: 'newly-evaluated-owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: loader,
      },
    });
    await Promise.resolve();
    expect(currentLocale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    japanese.resolve({ ChatInput__cancel: () => 'キャンセル' });
    await switching;
    expect(loader).toHaveBeenCalledTimes(1);
    expect(currentLocale.value).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(lazyStrings.ChatInput__cancel()).toBe('キャンセル');
  });

  it('rechecks a warmed owner replaced after its target locale was prepared', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Old cancel' } }),
        ja: resolvedModule({ module: { ChatInput__cancel: () => '旧キャンセル' } }),
      },
    });
    await ensureStrings.ChatInput__cancel();
    await prepareLocale({ locale: 'ja' });
    const japanese = Promise.withResolvers<StringBoundaryModule>();
    const loader = vi.fn(() => japanese.promise);
    const switching = setLocale({ locale: 'ja' });
    // Resume the loaded owner, the aggregate, then preparation. Commit remains queued.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    TEST_ONLY.beginBoundaryUpdate();
    try {
      registerTestStringBoundary({
        boundaryId: 'owner',
        keys: ['ChatInput__cancel'],
        loaders: {
          en: resolvedModule({ module: { ChatInput__cancel: () => 'New cancel' } }),
          ja: loader,
        },
      });
      await Promise.resolve();
      expect(currentLocale.value).toBe('en');
      expect(document.documentElement.lang).toBe('en');
      expect(lazyStrings.ChatInput__cancel()).toBe('Old cancel');
      japanese.resolve({ ChatInput__cancel: () => '新キャンセル' });
      await switching;
      expect(loader).toHaveBeenCalledTimes(1);
      expect(currentLocale.value).toBe('ja');
      expect(lazyStrings.ChatInput__cancel()).toBe('新キャンセル');
    } finally {
      await TEST_ONLY.finishBoundaryUpdate();
    }
  });

  it('preserves the active locale and original error when a late boundary cannot be prepared', async () => {
    vi.useFakeTimers();
    const failure = new Error('Late target locale failed');
    const loader = vi.fn(async () => {
      throw failure;
    });
    const switching = setLocale({ locale: 'ja' });
    const result = expect(switching).rejects.toBe(failure);
    await Promise.resolve();
    registerTestStringBoundary({
      boundaryId: 'late-owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: loader,
      },
    });
    await result;
    expect(loader).toHaveBeenCalledTimes(1);
    expect(currentLocale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('does not await a late owner removed before the locale-switch continuation', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ ChatInput__cancel: () => 'キャンセル' }));
    const switching = setLocale({ locale: 'ja' });
    await Promise.resolve();
    const { unregister } = registerTestStringBoundary({
      boundaryId: 'removed-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: loader, ja: loader },
    });
    unregister();
    await switching;
    expect(currentLocale.value).toBe('ja');
    expect(loader).not.toHaveBeenCalled();
    expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
  });

  it('uses a hot-installed late locale pack without fetching it again', async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => ({ ChatInput__cancel: () => 'Unused' }));
    const switching = setLocale({ locale: 'ja' });
    await Promise.resolve();
    const { updateLocale } = registerTestStringBoundary({
      boundaryId: 'late-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: loader, ja: loader },
    });
    updateLocale({ locale: 'ja', module: { ChatInput__cancel: () => '更新済み' } });
    await switching;
    expect(currentLocale.value).toBe('ja');
    expect(lazyStrings.ChatInput__cancel()).toBe('更新済み');
    expect(loader).not.toHaveBeenCalled();
  });

  it('keeps a newer locale request while a late target pack is pending', async () => {
    vi.useFakeTimers();
    const japanese = Promise.withResolvers<StringBoundaryModule>();
    const japaneseLoader = vi.fn(() => japanese.promise);
    const switching = setLocale({ locale: 'ja' });
    await Promise.resolve();
    registerTestStringBoundary({
      boundaryId: 'late-owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: japaneseLoader,
      },
    });
    await Promise.resolve();
    await setLocale({ locale: 'en' });
    expect(currentLocale.value).toBe('en');
    japanese.resolve({ ChatInput__cancel: () => 'キャンセル' });
    await switching;
    expect(currentLocale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(lazyStrings.ChatInput__cancel()).toBe('Cancel');
  });

  it('shares late target loading with a simultaneous imperative read in the active locale', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<StringBoundaryModule>();
    const loader = vi.fn(() => pending.promise);
    // Re-selecting the active locale still prepares newly discovered boundaries.
    const switching = setLocale({ locale: 'en' });
    await Promise.resolve();
    registerTestStringBoundary({
      boundaryId: 'late-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: loader, ja: loader },
    });
    await Promise.resolve();
    let switchFinished = false;
    const completion = switching.then(() => {
      switchFinished = true;
    });
    const message = ensureStrings.ChatInput__cancel();
    await Promise.resolve();
    expect(switchFinished).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve({ ChatInput__cancel: () => 'Ready cancel' });
    await completion;
    await expect(message).resolves.toBe('Ready cancel');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(lazyStrings.ChatInput__cancel()).toBe('Ready cancel');
  });

  it.each(['success', 'failure'] as const)(
    'moves an in-flight key read when its owner drops the key without awaiting an unrelated %s',
    async (replacementOutcome) => {
      vi.useFakeTimers();
      const abandoned = Promise.withResolvers<StringBoundaryModule>();
      registerTestStringBoundary({
        boundaryId: 'first-owner',
        keys: ['ChatInput__cancel'],
        loaders: { en: () => abandoned.promise, ja: () => abandoned.promise },
      });
      const remainingLoader = vi.fn(resolvedModule({
        module: { ChatInput__cancel: () => 'Remaining cancel' },
      }));
      registerTestStringBoundary({
        boundaryId: 'second-owner',
        keys: ['ChatInput__cancel'],
        loaders: { en: remainingLoader, ja: remainingLoader },
      });
      const pendingMessage = ensureStrings.ChatInput__cancel();
      const unrelatedLoader = vi.fn(async () => {
        if (replacementOutcome === 'failure') {
          throw new Error('Unrelated message failed');
        }
        return { ChatInput__type_a_message: () => 'Unrelated message' };
      });
      registerTestStringBoundary({
        boundaryId: 'first-owner',
        keys: ['ChatInput__type_a_message'],
        loaders: { en: unrelatedLoader, ja: unrelatedLoader },
      });

      await expect(pendingMessage).resolves.toBe('Remaining cancel');
      expect(remainingLoader).toHaveBeenCalledTimes(1);
      expect(unrelatedLoader).not.toHaveBeenCalled();
      expect(TEST_ONLY.loadedBoundaryModules.en.has('first-owner')).toBe(false);
      abandoned.reject(new Error('Obsolete import failed'));
      await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Remaining cancel');
      expect(remainingLoader).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a removed key without evaluating the replacement owner of another key', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: () => new Promise<StringBoundaryModule>(() => {}),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    const pendingMessage = ensureStrings.ChatInput__cancel();
    const unrelatedLoader = vi.fn(async () => {
      throw new Error('Unrelated message failed');
    });
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__type_a_message'],
      loaders: { en: unrelatedLoader, ja: unrelatedLoader },
    });

    await expect(pendingMessage).rejects.toThrow(
      'Boundary Strings key ChatInput__cancel has not been registered by a loaded module.',
    );
    expect(unrelatedLoader).not.toHaveBeenCalled();
    expect(TEST_ONLY.loadingBoundaries.size).toBe(0);
  });

  it('shares the remaining owner load between concurrent reads after their old owner drops the key', async () => {
    vi.useFakeTimers();
    const abandonedLoader = vi.fn(() => new Promise<StringBoundaryModule>(() => {}));
    registerTestStringBoundary({
      boundaryId: 'first-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: abandonedLoader, ja: abandonedLoader },
    });
    const remainingLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Remaining cancel' },
    }));
    registerTestStringBoundary({
      boundaryId: 'second-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: remainingLoader, ja: remainingLoader },
    });
    const first = ensureStrings.ChatInput__cancel();
    const second = ensureStrings.ChatInput__cancel();
    const unrelatedLoader = vi.fn(async () => {
      throw new Error('Unrelated message failed');
    });
    registerTestStringBoundary({
      boundaryId: 'first-owner',
      keys: ['ChatInput__type_a_message'],
      loaders: { en: unrelatedLoader, ja: unrelatedLoader },
    });

    await Promise.all([
      expect(first).resolves.toBe('Remaining cancel'),
      expect(second).resolves.toBe('Remaining cancel'),
    ]);
    expect(abandonedLoader).toHaveBeenCalledTimes(1);
    expect(remainingLoader).toHaveBeenCalledTimes(1);
    expect(unrelatedLoader).not.toHaveBeenCalled();
  });

  it('still propagates a replacement load failure when the replacement retains the requested key', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: () => new Promise<StringBoundaryModule>(() => {}),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    const pendingMessage = ensureStrings.ChatInput__cancel();
    const failure = new Error('Required replacement failed');
    const replacementLoader = vi.fn(async () => {
      throw failure;
    });
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel', 'ChatInput__type_a_message'],
      loaders: { en: replacementLoader, ja: replacementLoader },
    });
    await expect(pendingMessage).rejects.toBe(failure);
    expect(replacementLoader).toHaveBeenCalledTimes(1);
  });

  it('keeps full locale preparation independent from a key read whose owner changes keys', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'first-owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: () => new Promise<StringBoundaryModule>(() => {}),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    const remainingLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Remaining cancel' },
    }));
    registerTestStringBoundary({
      boundaryId: 'second-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: remainingLoader, ja: remainingLoader },
    });
    const pendingMessage = ensureStrings.ChatInput__cancel();
    const preparing = prepareLocale({ locale: 'en' });
    const failure = new Error('Another required boundary failed');
    const replacementLoader = vi.fn(async () => {
      throw failure;
    });
    registerTestStringBoundary({
      boundaryId: 'first-owner',
      keys: ['ChatInput__type_a_message'],
      loaders: { en: replacementLoader, ja: replacementLoader },
    });

    await Promise.all([
      expect(pendingMessage).resolves.toBe('Remaining cancel'),
      expect(preparing).rejects.toBe(failure),
    ]);
    expect(remainingLoader).toHaveBeenCalledTimes(1);
    expect(replacementLoader).toHaveBeenCalledTimes(1);
    expect(currentLocale.value).toBe('en');
  });

  it('rerenders a moved lazy key without loading the old owner replacement', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerTestStringBoundary({
      boundaryId: 'first-owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: () => new Promise<StringBoundaryModule>(() => {}),
        ja: resolvedModule({ module: { ChatInput__cancel: () => 'キャンセル' } }),
      },
    });
    const remainingLoader = vi.fn(resolvedModule({
      module: { ChatInput__cancel: () => 'Remaining cancel' },
    }));
    registerTestStringBoundary({
      boundaryId: 'second-owner',
      keys: ['ChatInput__cancel'],
      loaders: { en: remainingLoader, ja: remainingLoader },
    });
    const owner = mount(defineComponent({
      setup: () => () => h('span', lazyStrings.ChatInput__cancel()),
    }));
    try {
      expect(owner.text()).toBe('');
      const unrelatedLoader = vi.fn(async () => {
        throw new Error('Unrelated message failed');
      });
      registerTestStringBoundary({
        boundaryId: 'first-owner',
        keys: ['ChatInput__type_a_message'],
        loaders: { en: unrelatedLoader, ja: unrelatedLoader },
      });
      // Await the same key's real loading path, not idle warming of all owners.
      await expect(ensureStrings.ChatInput__cancel()).resolves.toBe('Remaining cancel');
      await nextTick();
      expect(owner.text()).toBe('Remaining cancel');
      expect(remainingLoader).toHaveBeenCalledTimes(1);
      expect(unrelatedLoader).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      owner.unmount();
      errors.mockRestore();
    }
  });

  it('still prepares a replacement boundary in full when its original key was removed', async () => {
    vi.useFakeTimers();
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__cancel'],
      loaders: {
        en: resolvedModule({ module: { ChatInput__cancel: () => 'Cancel' } }),
        ja: () => new Promise<StringBoundaryModule>(() => {}),
      },
    });
    const switching = setLocale({ locale: 'ja' });
    const replacementLoader = vi.fn(resolvedModule({
      module: { ChatInput__type_a_message: () => 'メッセージを入力...' },
    }));
    registerTestStringBoundary({
      boundaryId: 'owner',
      keys: ['ChatInput__type_a_message'],
      loaders: { en: replacementLoader, ja: replacementLoader },
    });
    await switching;
    expect(replacementLoader).toHaveBeenCalledTimes(1);
    expect(currentLocale.value).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
    expect(lazyStrings.ChatInput__type_a_message()).toBe('メッセージを入力...');
    expect(TEST_ONLY.registries.ja.ChatInput__cancel).toBeUndefined();
  });
});
