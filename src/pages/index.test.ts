import { afterEach, describe, it, expect, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type RouteLocationRaw } from 'vue-router';
import IndexPage from './index.vue';
import CurrentChatPane from '@/components/CurrentChatPane.vue';

enableAutoUnmount(afterEach);

// Entry routing is owned by MainAppSurface. The ordinary page stays lazy and
// route-neutral when mounted on its own.
vi.mock('../components/CurrentChatPane.vue', () => ({
  __esModule: true,
  __isTeleport: false,
  default: {
    name: 'CurrentChatPane',
    template: '<div data-testid="current-chat-pane"></div>',
  },
}));

async function mountIndexPage({ location }: { location: RouteLocationRaw }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: IndexPage }],
  });
  await router.push(location);
  await router.isReady();
  const wrapper = mount(IndexPage, { global: { plugins: [router] } });
  await flushPromises();
  return { router, wrapper };
}

describe('IndexPage', () => {
  it('renders CurrentChatPane', async () => {
    const { wrapper } = await mountIndexPage({ location: '/' });
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
  });

  it('keeps unrelated queries on the ordinary chat page', async () => {
    const { wrapper } = await mountIndexPage({ location: { path: '/', query: { model: 'other', q: 'hello' } } });
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
  });

  it.each(['hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M', ''])('leaves explicit model routing to the containing app surface: %s', async input => {
    const { wrapper } = await mountIndexPage({ location: { path: '/', query: { 'llama-cpp-browser-model': input } } });
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
  });

  it('keeps the ordinary pane stable while its containing app changes entry routing', async () => {
    const input = 'hf.co/LiquidAI/LFM2.5-230M-GGUF';
    const location = { path: '/', query: { 'llama-cpp-browser-model': input } };
    const { router, wrapper } = await mountIndexPage({ location });
    const pane = wrapper.getComponent(CurrentChatPane).vm;
    await router.replace('/');
    expect(wrapper.getComponent(CurrentChatPane).vm).toBe(pane);
    await router.push(location);
    expect(wrapper.getComponent(CurrentChatPane).vm).toBe(pane);
  });
});
