import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { createRouter, isNavigationFailure, RouterView } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import { createAppHistory } from '@/logic/startup/app-history';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { findModelSeoEntry } from './seo-entries';

const modelId = 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';
const pathname = `/llama-cpp-browser/${modelId}/`;

async function openEntry({ href }: { href: string }) {
  const previous = window.location.href;
  window.history.replaceState(undefined, '', href);
  const base = document.createElement('base');
  base.href = '/';
  document.head.prepend(base);
  const history = createAppHistory();
  const router = createRouter({
    history,
    routes: [
      { path: '/', component: { render: () => h('div', { 'data-testid': 'model-preview' }) } },
      { path: '/chat/:id', component: { render: () => h('div', { 'data-testid': 'chat' }) } },
      { path: '/settings', component: { render: () => h('div') } },
    ],
  });
  const initial = resolveInitialRoute({ router });
  const wrapper = mount(RouterView, { global: { plugins: [router] } });
  await router.isReady();
  return {
    router,
    wrapper,
    initial,
    [Symbol.dispose]() {
      wrapper.unmount();
      history.destroy();
      base.remove();
      window.history.replaceState(undefined, '', previous);
    },
  };
}

describe('model path history using the real Vue Router', () => {
  it('mounts without redirecting, adding a hash or another history entry', async () => {
    const length = window.history.length;
    using entry = await openEntry({ href: pathname });
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(length);
    expect(entry.initial.path).toBe('/');
    expect(entry.initial.query['llama-cpp-browser-model']).toBe(modelId);
    expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe(modelId);
    expect(entry.wrapper.find('[data-testid="model-preview"]').exists()).toBe(true);
    expect(entry.router.resolve(entry.router.currentRoute.value.fullPath).href).toBe(pathname);
  });

  it('replaces the model URL with the legacy chat URL and retains caller state', async () => {
    using entry = await openEntry({ href: pathname });
    const length = window.history.length;
    await entry.router.replace({ path: '/chat/created', state: { fromModelEntry: 'yes' } });
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('#/chat/created');
    expect(window.history.length).toBe(length);
    expect(window.history.state.fromModelEntry).toBe('yes');
    expect(entry.wrapper.find('[data-testid="chat"]').exists()).toBe(true);
    expect(entry.router.resolve('/settings').href).toBe('/#/settings');
    expect(entry.router.resolve('/chat/created?x=1#message').href).toBe('/#/chat/created?x=1#message');
  });

  it('keeps back/forward, route listeners, delta and entry state synchronized', async () => {
    using entry = await openEntry({ href: pathname });
    await entry.router.push({ path: '/settings', state: { settingsMarker: 'retained' } });
    entry.router.back();
    await vi.waitFor(() => expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe(modelId));
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('');
    entry.router.forward();
    await vi.waitFor(() => expect(entry.router.currentRoute.value.path).toBe('/settings'));
    expect(window.location.hash).toBe('#/settings');
    expect(window.history.state.settingsMarker).toBe('retained');
  });

  it('leaves the model URL unchanged when navigation is cancelled', async () => {
    using entry = await openEntry({ href: pathname });
    entry.router.beforeEach(to => to.path === '/chat/blocked' ? false : undefined);
    expect(isNavigationFailure(await entry.router.replace('/chat/blocked'))).toBe(true);
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('');
  });

  it('does not turn URL search parameters into prompts, settings or another model', async () => {
    const search = '?utm_source=search&q=do-not-send&llama-cpp-browser-model=other';
    using entry = await openEntry({ href: pathname + search });
    expect(entry.router.currentRoute.value.query).toEqual({ 'llama-cpp-browser-model': modelId });
    expect(window.location.search).toBe(search);
    expect(findModelSeoEntry({ pathname: window.location.pathname })?.canonicalUrl).not.toContain('?');
    await entry.router.replace('/chat/created');
    expect(window.location.search).toBe('');
  });

  it('preserves ordinary fragment links including unpublished models', async () => {
    using entry = await openEntry({ href: `/#/?${new URLSearchParams({ 'llama-cpp-browser-model': 'hf.co/owner/Other:Q8_0' })}` });
    expect(window.location.pathname).toBe('/');
    expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe('hf.co/owner/Other:Q8_0');
    expect(entry.router.resolve('/settings').href).toBe('#/settings');
  });

  it('keeps extra model queries in a fragment instead of dropping them', async () => {
    using entry = await openEntry({ href: pathname });
    const route = entry.router.resolve({ path: '/', query: { 'llama-cpp-browser-model': modelId, q: 'hello' } });
    expect(route.href).toMatch(/^\/#\//);
    expect(route.href).not.toContain('/llama-cpp-browser/');
  });

  it('resolves a pasted hybrid URL to the existing hash route only', async () => {
    using entry = await openEntry({ href: `${pathname}#/settings` });
    expect(entry.router.currentRoute.value.path).toBe('/settings');
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('#/settings');
  });

  it('normalizes a known encoded colon without inventing a different model', async () => {
    using entry = await openEntry({ href: pathname.replace(':', '%3A') });
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('');
    expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe(modelId);
  });
});
