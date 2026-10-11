import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provideDocumentMetadata } from '@/composables/useDocumentMetadata';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { lazyStrings } from '@/strings';
import { AUDIO_METADATA } from '@/logic/document-metadata';
import { useTransformersJsDocumentTitle } from './useTransformersJsDocumentTitle';

type State = { status: 'idle' | 'loading' | 'ready' | 'error', progress: number };
const listeners = new Set<(state: State) => void>();
vi.mock('@/features/transformers-js', () => ({
  transformersJsService: {
    getState: () => ({ status: 'loading', progress: 12 }),
    subscribe: ({ listener }: { listener: (state: State) => void }) => {
      listeners.add(listener); return () => {
        listeners.delete(listener);
      };
    },
  },
}));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); document.head.innerHTML = ''; listeners.clear();
});

describe('Transformers.js title ownership', () => {
  it('limits progress titles to a visible current chat and releases its service subscription', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: ['/chat/:id', '/audio-generation'].map(path => ({ path, component: { template: '<div />' } })) });
    await router.push('/chat/one');
    const visibility = ref<'visible' | 'hidden'>('visible');
    const Client = defineComponent({
      setup() {
        useTransformersJsDocumentTitle({ routePath: computed(() => '/chat/one'), visibility: computed(() => visibility.value) });
        return () => h('div');
      },
    });
    const wrapper = mount(defineComponent({
      setup() {
        provideDocumentMetadata({ router, document, homeIntroduction: ref({ kind: 'inactive' }), continueHomeIntroduction: () => {}, finishHomeIntroduction: () => {} });
        return () => h(Client);
      },
    }), { global: { plugins: [router] } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await nextTick();
    expect(document.title).toBe(lazyStrings.TransformersJsLoadingIndicator__loading_model_progress({ progress: 12 }));
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe('Naidan');
    visibility.value = 'hidden'; await nextTick(); expect(document.title).toBe('Naidan');
    visibility.value = 'visible';
    await router.push('/audio-generation');
    for (const listener of listeners) listener({ status: 'loading', progress: 99 });
    await nextTick(); expect(document.title).toBe(AUDIO_METADATA.title);
    await router.push('/chat/one');
    for (const listener of listeners) listener({ status: 'ready', progress: 100 });
    await nextTick(); expect(document.title).toBe('Naidan');
    wrapper.unmount(); expect(listeners.size).toBe(0);
  });
});
