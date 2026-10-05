import { afterEach, describe, it, expect, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type RouteLocationRaw } from 'vue-router';
import IndexPage from './index.vue';
import CurrentChatPane from '@/components/CurrentChatPane.vue';
import LlamaCppBrowserModelLaunchEntry from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue';

enableAutoUnmount(afterEach);

// Test the page's route selection, not the children or model discovery.
vi.mock('../components/CurrentChatPane.vue', () => ({
  default: {
    name: 'CurrentChatPane',
    template: '<div data-testid="current-chat-pane"></div>',
  },
}));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchEntry.vue', () => ({
  default: {
    name: 'LlamaCppBrowserModelLaunchEntry',
    props: ['input'],
    template: '<div data-testid="model-launch-entry"></div>',
  },
}));

async function mountIndexPage({ location }: { location: RouteLocationRaw }) {
  // The page now reads the fragment query. Supply a real router so route
  // injection and subsequent query changes are exercised, not fabricated.
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: IndexPage }],
  });
  await router.push(location);
  await router.isReady();
  return { router, wrapper: mount(IndexPage, { global: { plugins: [router] } }) };
}

describe('IndexPage', () => {
  it('renders CurrentChatPane', async () => {
    const { wrapper } = await mountIndexPage({ location: '/' });
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
    expect(wrapper.findComponent(LlamaCppBrowserModelLaunchEntry).exists()).toBe(false);
  });

  it('keeps unrelated queries on the ordinary chat page', async () => {
    const { wrapper } = await mountIndexPage({ location: { path: '/', query: { model: 'other', q: 'hello' } } });
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
    expect(wrapper.findComponent(LlamaCppBrowserModelLaunchEntry).exists()).toBe(false);
  });

  it.each(['hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M', ''])('forwards the explicit model query to the embedded entry: %s', async input => {
    const { wrapper } = await mountIndexPage({ location: { path: '/', query: { 'llama-cpp-browser-model': input } } });
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(false);
    expect(wrapper.getComponent(LlamaCppBrowserModelLaunchEntry).props('input')).toBe(input);
  });

  it('reacts to consuming and revisiting a model query without remounting the page', async () => {
    const input = 'hf.co/LiquidAI/LFM2.5-230M-GGUF';
    const location = { path: '/', query: { 'llama-cpp-browser-model': input } };
    const { router, wrapper } = await mountIndexPage({ location });
    expect(wrapper.findComponent(LlamaCppBrowserModelLaunchEntry).exists()).toBe(true);
    await router.replace('/');
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(true);
    expect(wrapper.findComponent(LlamaCppBrowserModelLaunchEntry).exists()).toBe(false);
    await router.push(location);
    expect(wrapper.getComponent(LlamaCppBrowserModelLaunchEntry).props('input')).toBe(input);
    expect(wrapper.findComponent(CurrentChatPane).exists()).toBe(false);
  });
});
