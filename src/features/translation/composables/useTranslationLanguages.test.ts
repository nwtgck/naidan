import { describe, expect, it } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type LocationQuery } from 'vue-router';
import { readTranslationLanguages, useTranslationLanguages } from './useTranslationLanguages';

async function fixture({ path }: { path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/translation', component: { template: '<div />' } }, { path: '/', component: { template: '<div />' } }] });
  await router.push(path);
  const defaultTarget = ref('ja');
  let state: ReturnType<typeof useTranslationLanguages> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      state = useTranslationLanguages({ defaultTarget });
      return () => h('div');
    },
  }), { global: { plugins: [router] } });
  if (!state) {
    throw new Error('Language fixture did not mount');
  }
  return {
    state,
    router,
    defaultTarget,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('translation language URL ownership', () => {
  it('keeps an untouched URL bare and uses automatic source plus the model default', async () => {
    using f = await fixture({ path: '/translation' });
    expect(f.state.sourceLang.value).toBeUndefined();
    expect(f.state.targetLang.value).toBe('ja');
    expect(f.router.currentRoute.value.fullPath).toBe('/translation');
    f.defaultTarget.value = 'en';
    expect(f.state.targetLang.value).toBe('en');
  });

  it('preserves explicit targets independently of the default and preserves unrelated parameters', async () => {
    using f = await fixture({ path: '/translation?from=ja&to=en&settings=connection#detail' });
    f.defaultTarget.value = 'ko';
    expect(f.state.targetLang.value).toBe('en');
    expect(await f.state.choose({ source: 'fr', target: 'de' })).toBe(true);
    expect(f.router.currentRoute.value.query).toEqual({ from: 'fr', to: 'de', settings: 'connection' });
    expect(f.router.currentRoute.value.hash).toBe('#detail');
  });

  it('omits default choices without retaining a persisted language preference', async () => {
    using f = await fixture({ path: '/translation?from=ja&to=en' });
    await f.state.choose({ source: undefined, target: 'ja' });
    expect(f.router.currentRoute.value.fullPath).toBe('/translation');
  });

  it('keeps unsupported scalar language codes visible for validation', async () => {
    using f = await fixture({ path: '/translation?from=unknown&to=unknown' });
    expect(f.state.sourceLang.value).toBe('unknown');
    expect(f.state.targetLang.value).toBe('unknown');
  });

  it('does not turn malformed or repeated URL arguments into a valid request', () => {
    const queries: LocationQuery[] = [{ from: ['ja', 'en'] }, { to: ['ja', 'en'] }, { to: '' }, { to: null }, { from: null }];
    for (const query of queries) {
      expect(readTranslationLanguages({ query }).invalid).toBe(true);
    }
    expect(readTranslationLanguages({ query: { from: 'auto' } })).toEqual({ sourceLang: undefined, targetLang: undefined, invalid: false });
  });

  it('honors external route changes without writing another history entry', async () => {
    using f = await fixture({ path: '/translation?to=en' });
    await f.router.push('/translation?from=ko&to=fr');
    expect(f.state.sourceLang.value).toBe('ko');
    expect(f.state.targetLang.value).toBe('fr');
    await f.state.choose({ source: 'ko', target: 'de' });
    expect(f.state.targetLang.value).toBe('de');
  });

  it('does not report a cancelled navigation as a successful language change', async () => {
    using f = await fixture({ path: '/translation?to=en' });
    f.router.beforeEach(() => false);
    expect(await f.state.choose({ source: undefined, target: 'ko' })).toBe(false);
    expect(f.state.targetLang.value).toBe('en');
    expect(f.state.changing.value).toBe(false);
  });
});
