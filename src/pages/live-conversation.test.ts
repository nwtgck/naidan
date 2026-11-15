import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import LiveConversationPage from './live-conversation.vue';

const mounts = vi.hoisted(() => vi.fn());
vi.mock('@/features/live-conversation/components/LiveConversationView.vue', () => ({
  default: defineComponent({
    props: ['panel'],
    emits: ['openConversation', 'openDiagnostics'],
    setup(props, { emit }) {
      mounts();
      return () => h('div', { 'data-testid': 'live-owner' }, [
        h('span', { 'data-testid': 'live-panel' }, props.panel),
        h('button', { 'data-testid': 'open-tools', onClick: () => emit('openDiagnostics') }),
        h('button', { 'data-testid': 'open-conversation', onClick: () => emit('openConversation') }),
      ]);
    },
  }),
}));

beforeEach(() => {
  mounts.mockClear();
});

async function fixture({ path }: { path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/live-conversation', component: LiveConversationPage, children: [{ path: 'diagnostics', component: { template: '<span />' } }] }] });
  await router.push({ path, query: { settings: 'connection' }, hash: '#audio' });
  const wrapper = mount(defineComponent({ setup: () => () => h(RouterView) }), { global: { plugins: [router] } });
  await flushPromises();
  return {
    wrapper,
    router,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Live Conversation investigation route', () => {
  it('keeps the model owner mounted between conversation and diagnostics and preserves URL state', async () => {
    using f = await fixture({ path: '/live-conversation' });
    const owner = f.wrapper.get('[data-testid="live-owner"]').element;
    await f.wrapper.get('[data-testid="open-tools"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/live-conversation/diagnostics');
    expect(f.router.currentRoute.value.query).toEqual({ settings: 'connection' });
    expect(f.router.currentRoute.value.hash).toBe('#audio');
    expect(f.wrapper.get('[data-testid="live-panel"]').text()).toBe('diagnostics');
    expect(f.wrapper.get('[data-testid="live-owner"]').element).toBe(owner);
    await f.wrapper.get('[data-testid="open-conversation"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/live-conversation');
    expect(mounts).toHaveBeenCalledOnce();
  });

  it('opens a direct diagnostics URL with the same retained parent', async () => {
    using f = await fixture({ path: '/live-conversation/diagnostics' });
    expect(f.wrapper.get('[data-testid="live-panel"]').text()).toBe('diagnostics');
    expect(mounts).toHaveBeenCalledOnce();
  });
});
