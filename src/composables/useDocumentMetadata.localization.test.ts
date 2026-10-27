import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, type Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_LOCALES, type UiLocale } from '@/01-models/ui-locale';
import LanguageSelector from '@/components/LanguageSelector.vue';
import { APPLICATION_METADATA, AUDIO_METADATA, HOME_METADATA } from '@/logic/document-metadata';
import { STANDALONE_PACKAGE_LOCALE_META_NAME } from '@/features/file-protocol-standalone/logic/package-locale';
import { currentLocale, registerStringBoundary, setLocale, TEST_ONLY as stringsTestOnly, type StringBoundaryLoaders, type StringBoundaryModule } from '@/strings/runtime';
import { TEST_ONLY as presentationTestOnly } from './useAppPresentation';
import { provideDocumentMetadata, useDocumentMetadata, useDocumentTitleOverride } from './useDocumentMetadata';

// Exercise the selector against the real strings runtime. Settings persistence
// and its commit ordering are covered by useSettings.test.ts.
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({ setLocale }),
}));

const titleKey = 'documentTitle__run_ai_on_your_device_directly_in_your_browser';
// Retain the actual generated pack loaders, rather than eager locale catalogs
// or copies of message implementations. Only timing/failure tests wrap them.
const registrations = [...stringsTestOnly.boundaryRegistrations.values()];
const titleRegistration = registrations.find(registration => registration.keys.includes(titleKey));
if (titleRegistration === undefined) {
  throw new Error('The document metadata module did not register its title boundary.');
}
const titleLoaders = titleRegistration.loaders;
const expectedTitles: Record<UiLocale, string> = {
  en: HOME_METADATA.title,
  ja: 'Naidan | 端末のブラウザ内でAIを実行',
  'zh-Hans': 'Naidan | 在你的设备上，直接在浏览器中运行 AI',
  'pt-BR': 'Naidan | Execute IA no seu dispositivo, diretamente no navegador',
  es: 'Naidan | Ejecuta IA en tu dispositivo, directamente en tu navegador',
  ko: 'Naidan | 내 기기의 브라우저에서 직접 AI 실행',
  de: 'Naidan | KI auf deinem Gerät ausführen, direkt im Browser',
};
const Empty = defineComponent({ render: () => h('div') });

function registerBoundaries({ loaders }: { loaders: StringBoundaryLoaders }): void {
  for (const registration of registrations) {
    registerStringBoundary({
      boundaryId: registration.boundaryId,
      keys: registration.keys,
      loaders: registration.keys.includes(titleKey) ? loaders : registration.loaders,
    });
  }
}

async function mountMetadata({ path, content }: { path: string, content: Component }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Empty },
      { path: '/audio-generation', component: Empty },
    ],
  });
  await router.push(path);
  const introduction = presentationTestOnly.createHomeIntroduction({ router });
  const wrapper = mount(defineComponent({
    setup() {
      provideDocumentMetadata({ router, document, ...introduction });
      return () => h(content);
    },
  }), { global: { plugins: [router] } });
  return {
    router,
    introduction,
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function expectHomeTitle({ title }: { title: string }): void {
  expect(document.title).toBe(title);
  expect(document.head.querySelectorAll('title')).toHaveLength(1);
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    expect(document.head.querySelectorAll(selector)).toHaveLength(1);
    expect(document.head.querySelector(selector)?.getAttribute('content')).toBe(title);
  }
  expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(HOME_METADATA.description);
}

beforeEach(() => {
  document.head.innerHTML = '';
  stringsTestOnly.reset();
  registerBoundaries({ loaders: titleLoaders });
});

describe('localized home document title', () => {
  it.each(UI_LOCALES)('uses the real %s title pack for the document and social titles', async locale => {
    using _owner = await mountMetadata({ path: '/', content: Empty });
    await setLocale({ locale });
    await nextTick();
    expectHomeTitle({ title: expectedTitles[locale] });
  });

  it('keeps the initial English title until the active locale boundary resolves', async () => {
    const japaneseModule = await titleLoaders.ja();
    const pending = Promise.withResolvers<StringBoundaryModule>();
    using _completion = {
      [Symbol.dispose]() {
        pending.resolve(japaneseModule);
      },
    };
    stringsTestOnly.reset();
    await setLocale({ locale: 'ja' });
    registerBoundaries({ loaders: { ...titleLoaders, ja: () => pending.promise } });
    using _owner = await mountMetadata({ path: '/', content: Empty });
    expectHomeTitle({ title: HOME_METADATA.title });

    pending.resolve(japaneseModule);
    await flushPromises();
    expectHomeTitle({ title: expectedTitles.ja });
  });

  it('uses the saved effective locale on the first runtime application', async () => {
    await setLocale({ locale: 'ja' });
    using _owner = await mountMetadata({ path: '/', content: Empty });
    expectHomeTitle({ title: expectedTitles.ja });
  });

  it('updates through the language selector without ending the home introduction', async () => {
    await setLocale({ locale: 'en' });
    using owner = await mountMetadata({ path: '/', content: LanguageSelector });
    await owner.wrapper.get('[data-testid="language-selector-toggle"]').trigger('click');
    const option = owner.wrapper.findAll('[data-testid="language-selector-option"]')
      .find(candidate => candidate.text() === '日本語');
    expect(option).toBeDefined();
    await option!.trigger('click');
    await vi.waitFor(() => expectHomeTitle({ title: expectedTitles.ja }));
    expect(currentLocale.value).toBe('ja');
    expect(owner.introduction.homeIntroduction.value.kind).toBe('active');
  });

  it('keeps the committed title after a preparation failure and allows retry', async () => {
    stringsTestOnly.reset();
    registerBoundaries({
      loaders: {
        ...titleLoaders,
        ja: vi.fn(titleLoaders.ja).mockRejectedValueOnce(new Error('Title pack unavailable')),
      },
    });
    using _owner = await mountMetadata({ path: '/', content: Empty });
    await setLocale({ locale: 'en' });
    await nextTick();
    await expect(setLocale({ locale: 'ja' })).rejects.toThrow('Title pack unavailable');
    await nextTick();
    expect(currentLocale.value).toBe('en');
    expectHomeTitle({ title: HOME_METADATA.title });

    await setLocale({ locale: 'ja' });
    await nextTick();
    expectHomeTitle({ title: expectedTitles.ja });
  });

  it('keeps the latest committed locale when an earlier request finishes late', async () => {
    const japaneseModule = await titleLoaders.ja();
    const pending = Promise.withResolvers<StringBoundaryModule>();
    using _completion = {
      [Symbol.dispose]() {
        pending.resolve(japaneseModule);
      },
    };
    const japaneseLoader = vi.fn(() => pending.promise);
    stringsTestOnly.reset();
    registerBoundaries({ loaders: { ...titleLoaders, ja: japaneseLoader } });
    using _owner = await mountMetadata({ path: '/', content: Empty });
    await setLocale({ locale: 'en' });

    const earlier = setLocale({ locale: 'ja' });
    await vi.waitFor(() => expect(japaneseLoader).toHaveBeenCalledOnce());
    await setLocale({ locale: 'de' });
    await nextTick();
    expectHomeTitle({ title: expectedTitles.de });
    pending.resolve(japaneseModule);
    await earlier;
    await nextTick();
    expect(currentLocale.value).toBe('de');
    expectHomeTitle({ title: expectedTitles.de });
  });

  it.each(['navigation', 'dismissal'] as const)('ignores late title loading after %s ends the introduction', async reason => {
    const japaneseModule = await titleLoaders.ja();
    const pending = Promise.withResolvers<StringBoundaryModule>();
    using _completion = {
      [Symbol.dispose]() {
        pending.resolve(japaneseModule);
      },
    };
    stringsTestOnly.reset();
    await setLocale({ locale: 'ja' });
    registerBoundaries({ loaders: { ...titleLoaders, ja: () => pending.promise } });
    using owner = await mountMetadata({ path: '/', content: Empty });
    expectHomeTitle({ title: HOME_METADATA.title });
    switch (reason) {
    case 'navigation':
      await owner.router.push('/audio-generation');
      expect(document.title).toBe(AUDIO_METADATA.title);
      break;
    case 'dismissal':
      owner.introduction.finishHomeIntroduction();
      await nextTick();
      expect(document.title).toBe(APPLICATION_METADATA.title);
      break;
    default: {
      const _ex: never = reason;
      throw new Error(`Unhandled introduction completion: ${_ex}`);
    }
    }
    pending.resolve(japaneseModule);
    await flushPromises();
    await owner.router.push('/');
    await nextTick();
    expect(document.title).toBe(APPLICATION_METADATA.title);
    expect(owner.introduction.homeIntroduction.value.kind).toBe('inactive');
  });

  it('restores the latest localized home title after printing and ignores background loading titles', async () => {
    const printed = Promise.withResolvers<void>();
    using _completion = {
      [Symbol.dispose]() {
        printed.resolve();
      },
    };
    let manager: ReturnType<typeof useDocumentMetadata>;
    using _owner = await mountMetadata({
      path: '/',
      content: defineComponent({
        setup() {
          manager = useDocumentMetadata();
          useDocumentTitleOverride({ kind: 'model-loading', source: computed(() => ({ routePath: '/', title: 'Loading 50%' })) });
          return () => h('div');
        },
      }),
    });
    await setLocale({ locale: 'ja' });
    await nextTick();
    expectHomeTitle({ title: expectedTitles.ja });
    const operation = manager!.withPrintTitle({ title: 'Printed chat', run: () => printed.promise });
    expect(document.title).toBe('Printed chat');
    await setLocale({ locale: 'de' });
    await nextTick();
    expect(document.title).toBe('Printed chat');
    expect(document.head.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(expectedTitles.de);
    printed.resolve();
    await operation;
    expectHomeTitle({ title: expectedTitles.de });
  });

  it('uses the constrained package locale without loading the English title pack', async () => {
    stringsTestOnly.reset();
    const meta = document.createElement('meta');
    meta.name = STANDALONE_PACKAGE_LOCALE_META_NAME;
    meta.content = 'ja';
    document.head.append(meta);
    using _package = {
      [Symbol.dispose]() {
        meta.remove();
      },
    };
    const englishLoader = vi.fn(titleLoaders.en);
    registerBoundaries({ loaders: { ...titleLoaders, en: englishLoader } });
    await setLocale({ locale: 'en' });
    using _owner = await mountMetadata({ path: '/', content: Empty });
    expect(currentLocale.value).toBe('ja');
    expectHomeTitle({ title: expectedTitles.ja });
    expect(englishLoader).not.toHaveBeenCalled();
  });

  it.each(['/?q=hello', '/?settings=connection', '/?llama-cpp-browser-model=owner/model'])('does not apply the localized home title to %s', async path => {
    await setLocale({ locale: 'ja' });
    using _owner = await mountMetadata({ path, content: Empty });
    expect(document.title).toBe(APPLICATION_METADATA.title);
  });
});
