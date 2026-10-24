import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, KeepAlive, nextTick, ref, shallowRef, type Component } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { APPLICATION_METADATA, AUDIO_METADATA, HOME_METADATA, IMAGE_METADATA, type PageMetadata } from '@/logic/document-metadata';
import { TEST_ONLY as presentationTestOnly } from './useAppPresentation';
import { provideDocumentMetadata, useDocumentMetadata, useDocumentTitleOverride, usePageDocumentMetadata } from './useDocumentMetadata';

function mountOwner({ router, content, introduction }: {
  router: Router,
  content: Component,
  introduction: ReturnType<typeof presentationTestOnly.createHomeIntroduction>,
}) {
  const wrapper = mount(defineComponent({
    setup() {
      provideDocumentMetadata({ router, document, ...introduction });
      return () => h(content);
    },
  }), { global: { plugins: [router] } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function routerForPages() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: {} },
      { path: '/chat/:id', component: {} },
      { path: '/audio-generation', component: {} },
      { path: '/image-generation', component: {}, children: [{ path: 'session/:id', component: {} }] },
    ],
  });
}

function expectHead({ page, documentTitle }: { page: PageMetadata, documentTitle: string }): void {
  expect(document.title).toBe(documentTitle);
  expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(page.description);
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    expect(document.head.querySelector(selector)?.getAttribute('content')).toBe(page.title);
  }
  for (const selector of ['meta[property="og:description"]', 'meta[name="twitter:description"]']) {
    expect(document.head.querySelector(selector)?.getAttribute('content')).toBe(page.description);
  }
}

beforeEach(() => {
  document.head.innerHTML = '';
});

describe('document metadata ownership', () => {
  it('uses the homepage metadata while the root introduction is visible', async () => {
    const router = routerForPages();
    await router.push('/');
    using _owner = mountOwner({ router, introduction: presentationTestOnly.createHomeIntroduction({ router }), content: defineComponent({ template: '<div />' }) });
    await nextTick();
    expectHead({ page: HOME_METADATA, documentTitle: HOME_METADATA.title });
  });

  it('matches the same routed page with a trailing slash for both page and loading sources', async () => {
    const router = routerForPages();
    await router.push('/chat/one/');
    const loading = ref<string | undefined>('Loading 12%');
    const metadata = { title: 'Model guide', description: 'Model description' };
    using _owner = mountOwner({
      router,
      introduction: presentationTestOnly.createHomeIntroduction({ router }),
      content: defineComponent({
        setup() {
          usePageDocumentMetadata({ source: computed(() => ({ routePath: '/chat/one', metadata })) });
          useDocumentTitleOverride({ kind: 'model-loading', source: computed(() => loading.value === undefined ? undefined : { routePath: '/chat/one', title: loading.value }) });
          return () => h('div');
        },
      }),
    });
    await nextTick();
    expectHead({ page: metadata, documentTitle: 'Loading 12%' });
    loading.value = undefined;
    await nextTick();
    expectHead({ page: metadata, documentTitle: metadata.title });
  });

  it('disables a kept-alive page source until it is activated again', async () => {
    const router = routerForPages();
    await router.push('/chat/one');
    const visible = ref(true);
    const metadata = { title: 'Cached guide', description: 'Cached description' };
    const Guide = defineComponent({
      setup() {
        usePageDocumentMetadata({ source: computed(() => ({ routePath: '/chat/one', metadata })) });
        return () => h('div');
      },
    });
    using _owner = mountOwner({ router, introduction: presentationTestOnly.createHomeIntroduction({ router }), content: defineComponent({ setup: () => () => h(KeepAlive, () => visible.value ? h(Guide) : undefined) }) });
    await nextTick();
    expectHead({ page: metadata, documentTitle: metadata.title });
    visible.value = false;
    await nextTick();
    await nextTick();
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Naidan' });
    visible.value = true;
    await nextTick();
    await nextTick();
    expectHead({ page: metadata, documentTitle: metadata.title });
  });

  it('ignores late print completion after its document owner has unmounted', async () => {
    const router = routerForPages();
    await router.push('/chat/one');
    const printed = Promise.withResolvers<void>();
    let manager: ReturnType<typeof useDocumentMetadata>;
    using owner = mountOwner({
      router,
      introduction: presentationTestOnly.createHomeIntroduction({ router }),
      content: defineComponent({
        setup() {
          manager = useDocumentMetadata();
          return () => h('div');
        },
      }),
    });
    const operation = manager!.withPrintTitle({ title: 'Old print', run: () => printed.promise });
    owner.wrapper.unmount();
    const nextRouter = routerForPages();
    await nextRouter.push('/audio-generation');
    using _nextOwner = mountOwner({ router: nextRouter, introduction: presentationTestOnly.createHomeIntroduction({ router: nextRouter }), content: defineComponent({ template: '<div />' }) });
    await nextTick();
    printed.resolve();
    await operation;
    expectHead({ page: AUDIO_METADATA, documentTitle: AUDIO_METADATA.title });
  });

  it('recomputes the current page after print and loading overrides, including navigation during printing', async () => {
    const router = routerForPages();
    await router.push('/chat/one');
    const introduction = presentationTestOnly.createHomeIntroduction({ router });
    const loading = ref<string | undefined>('Loading 35%');
    const printed = Promise.withResolvers<void>();
    let print: ReturnType<typeof useDocumentMetadata>;
    using _owner = mountOwner({
      router,
      introduction,
      content: defineComponent({
        setup() {
          print = useDocumentMetadata();
          useDocumentTitleOverride({ kind: 'model-loading', source: computed(() => loading.value === undefined ? undefined : { routePath: '/chat/one', title: loading.value }) });
          return () => h('div');
        },
      }),
    });
    await nextTick();
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Loading 35%' });
    const operation = print!.withPrintTitle({ title: 'Private print title', run: () => printed.promise });
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Private print title' });
    await router.push('/audio-generation');
    loading.value = 'Loading 80%';
    await nextTick();
    expectHead({ page: AUDIO_METADATA, documentTitle: 'Private print title' });
    printed.resolve();
    await operation;
    expectHead({ page: AUDIO_METADATA, documentTitle: AUDIO_METADATA.title });
  });

  it('only releases the old owner, rejects inactive panes, and restores a complete metadata pair', async () => {
    const router = routerForPages();
    await router.push('/chat/one');
    const showOld = ref(true), showNew = ref(false);
    const source = shallowRef({ title: 'New guide', description: 'New description' });
    const Old = defineComponent({
      setup() {
        usePageDocumentMetadata({ source: computed(() => ({ routePath: '/chat/one', metadata: { title: 'Old guide', description: 'Old description' } })) });
        return () => h('div');
      },
    });
    const New = defineComponent({
      setup() {
        usePageDocumentMetadata({ source: computed(() => ({ routePath: '/chat/one', metadata: source.value })) });
        return () => h('div');
      },
    });
    using _owner = mountOwner({
      router,
      introduction: presentationTestOnly.createHomeIntroduction({ router }),
      content: defineComponent({
        setup: () => () => h('div', [showOld.value ? h(Old) : undefined, showNew.value ? h(New) : undefined]),
      }),
    });
    await nextTick();
    showNew.value = true;
    await nextTick();
    showOld.value = false;
    await nextTick();
    expectHead({ page: source.value, documentTitle: source.value.title });
    source.value = { title: 'Changed model', description: 'Changed description' };
    await nextTick();
    expectHead({ page: source.value, documentTitle: source.value.title });
    await router.push('/chat/two');
    await nextTick();
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Naidan' });
    showNew.value = false;
    await router.push('/chat/one');
    await nextTick();
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Naidan' });
  });

  it('ends the image introduction when a restored session opens and applies the audio introduction on navigation', async () => {
    const router = routerForPages();
    await router.push('/image-generation');
    const restored = Promise.withResolvers<void>();
    using _owner = mountOwner({
      router,
      introduction: presentationTestOnly.createHomeIntroduction({ router }),
      content: defineComponent({
        setup() {
          void restored.promise.then(() => router.replace('/image-generation/session/restored'));
          return () => h('div');
        },
      }),
    });
    expectHead({ page: IMAGE_METADATA, documentTitle: IMAGE_METADATA.title });
    restored.resolve();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/image-generation/session/restored');
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Naidan' });
    await router.push('/audio-generation');
    await flushPromises();
    expectHead({ page: AUDIO_METADATA, documentTitle: AUDIO_METADATA.title });
  });

  it('releases the homepage introduction and accepts progress titles after navigation to a chat', async () => {
    const router = routerForPages();
    await router.push('/');
    const introduction = presentationTestOnly.createHomeIntroduction({ router });
    const progress = ref('Loading 15%');
    using _owner = mountOwner({
      router,
      introduction,
      content: defineComponent({
        setup() {
          useDocumentTitleOverride({ kind: 'model-loading', source: computed(() => ({ routePath: '/chat/automatic', title: progress.value })) });
          return () => h('div');
        },
      }),
    });
    await router.push('/chat/automatic');
    progress.value = 'Loading 90%';
    await flushPromises();
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Loading 90%' });
    introduction.finishHomeIntroduction();
    await nextTick();
    expect(document.title).toBe('Loading 90%');
    expect(introduction.homeIntroduction.value.kind).toBe('inactive');
    await router.push('/chat/late-result');
    expectHead({ page: APPLICATION_METADATA, documentTitle: 'Naidan' });
  });

  it('adopts existing tags without accumulating duplicates or modifying unrelated head elements', async () => {
    document.head.innerHTML = '<meta name="description" content="old"><meta name="description" content="duplicate"><meta name="referrer" content="no-referrer"><link rel="canonical" href="https://example.test/">';
    const router = routerForPages();
    await router.push('/audio-generation');
    using _owner = mountOwner({ router, introduction: presentationTestOnly.createHomeIntroduction({ router }), content: defineComponent({ template: '<div />' }) });
    await router.push('/image-generation');
    await router.push('/audio-generation');
    await flushPromises();
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://example.test/');
    expectHead({ page: AUDIO_METADATA, documentTitle: AUDIO_METADATA.title });
  });
});
