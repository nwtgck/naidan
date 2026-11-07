import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { createRouter, isNavigationFailure, RouterView } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import { createAppHistory } from '@/logic/startup/app-history';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { findModelPageEntry } from './page-entries';

const modelId = 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';
const pathname = '/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF/';
const entryHref = `${pathname}?quant=Q4_K_M`;

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
    using entry = await openEntry({ href: entryHref });
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('');
    expect(window.history.length).toBe(length);
    expect(entry.initial.path).toBe('/');
    expect(entry.initial.query['llama-cpp-browser-model']).toBe(modelId);
    expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe(modelId);
    expect(entry.wrapper.find('[data-testid="model-preview"]').exists()).toBe(true);
    expect(entry.router.resolve(entry.router.currentRoute.value.fullPath).href).toBe(entryHref);
  });

  it('replaces the model URL with the legacy chat URL and retains caller state', async () => {
    using entry = await openEntry({ href: entryHref });
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
    using entry = await openEntry({ href: entryHref });
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
    using entry = await openEntry({ href: entryHref });
    entry.router.beforeEach(to => to.path === '/chat/blocked' ? false : undefined);
    expect(isNavigationFailure(await entry.router.replace('/chat/blocked'))).toBe(true);
    expect(window.location.pathname).toBe(pathname);
    expect(window.location.hash).toBe('');
  });

  it('does not turn URL search parameters into prompts, settings or another model', async () => {
    const search = '?utm_source=search&q=do-not-send&llama-cpp-browser-model=other';
    using entry = await openEntry({ href: `${entryHref}&${search.slice(1)}` });
    expect(entry.router.currentRoute.value.query).toEqual({ 'llama-cpp-browser-model': modelId });
    expect(window.location.search).toBe(`?quant=Q4_K_M&${search.slice(1)}`);
    expect(findModelPageEntry({ pathname: window.location.pathname })?.canonicalUrl).not.toContain('?');
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
    using entry = await openEntry({ href: entryHref });
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

  it('accepts one-time encoded repository characters without changing the requested model', async () => {
    using entry = await openEntry({ href: entryHref.replace('LiquidAI', '%4CiquidAI') });
    expect(window.location.pathname).toBe(pathname.replace('LiquidAI', '%4CiquidAI'));
    expect(window.location.hash).toBe('');
    expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe(modelId);
  });

  it.each([
    { href: '/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF', input: 'hf.co/LiquidAI/LFM2.5-230M-GGUF' },
    { href: '/llama-cpp-browser/hf.co/owner/Unlisted-GGUF', input: 'hf.co/owner/Unlisted-GGUF' },
    { href: '/llama-cpp-browser/hf.co/owner/Unlisted-GGUF/?quant=Q8_0', input: 'hf.co/owner/Unlisted-GGUF:Q8_0' },
  ])('opens $href without a publication lookup, then returns to hash chat navigation', async ({ href, input }) => {
    using entry = await openEntry({ href });
    expect(window.location.pathname + window.location.search).toBe(href);
    expect(window.location.hash).toBe('');
    expect(entry.initial.query['llama-cpp-browser-model']).toBe(input);
    expect(entry.router.resolve(entry.router.currentRoute.value.fullPath).href).toBe(href);
    await entry.router.push('/settings');
    entry.router.back();
    await vi.waitFor(() => expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe(input));
    expect(window.location.pathname + window.location.search).toBe(href);
    await entry.router.replace('/chat/unlisted');
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#/chat/unlisted');
  });

  it.each(['?quant=', '?quant=Q4_K_M&quant=Q8_0', '?quant=bad%2Fpath'])('keeps %s as a repairable invalid entry rather than launching a fallback model', async search => {
    using entry = await openEntry({ href: pathname + search });
    expect(entry.router.currentRoute.value.query).toEqual({ 'llama-cpp-browser-model': '' });
    expect(window.location.pathname + window.location.search).toBe(pathname + search);
    expect(window.location.hash).toBe('');
    await entry.router.push('/');
    expect(window.location.href).toBe(new URL('/#/', window.location.origin).href);
  });

  it('does not parse a malformed model path into a different repository', async () => {
    const href = '/llama-cpp-browser/hf.co/owner%2Fother/Model';
    using entry = await openEntry({ href });
    expect(entry.router.currentRoute.value.query['llama-cpp-browser-model']).toBe('');
    expect(window.location.pathname).toBe(href);
  });
});
