import { enableAutoUnmount, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MainAppSurface from './MainAppSurface.vue';

enableAutoUnmount(afterEach);

const mountSpy = vi.fn();
const unmountSpy = vi.fn();

const MockCurrentChatPane = defineComponent({
  name: 'CurrentChatPane',
  template: '<div data-testid="current-chat-pane">Chat Content</div>',
  mounted() {
    mountSpy();
  },
  unmounted() {
    unmountSpy();
  },
});

vi.mock('@/composables/useLayout', () => ({
  useLayout: () => ({
    isSidebarOpen: ref(true),
    isDebugOpen: ref(false),
  }),
}));

vi.mock('@/composables/useAppEntry', () => ({ useAppEntry: () => ({ intent: ref({ kind: 'ordinary' }) }) }));
vi.mock('@/components/HomeWelcome.vue', () => ({ default: { template: '<div />' } }));

vi.mock('@/components/AppSidebar.vue', () => ({
  default: {
    props: ['postStartupFeatures'],
    template: '<div data-testid="app-sidebar" />',
  },
}));

vi.mock('@/components/DebugPanel.vue', () => ({
  default: {
    template: '<div data-testid="debug-panel" />',
  },
}));

describe('MainAppSurface navigation', () => {
  beforeEach(() => {
    mountSpy.mockClear();
    unmountSpy.mockClear();
  });

  it('reuses the route component between chats to prevent flickering', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: MockCurrentChatPane },
        { path: '/chat/:id', component: MockCurrentChatPane },
      ],
    });
    await router.push('/');
    await router.isReady();

    const wrapper = mount(MainAppSurface, {
      props: {
        postStartupFeatures: 'inactive',
      },
      global: {
        plugins: [router],
        stubs: {
          transition: false,
        },
      },
    });
    const sidebar = wrapper.get('[data-testid="app-sidebar"]').element;
    const pane = wrapper.get('[data-testid="current-chat-pane"]').element;

    expect(mountSpy).toHaveBeenCalledOnce();

    await router.push('/chat/chat-1');
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="current-chat-pane"]').element).toBe(pane);
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);

    await router.push('/chat/chat-2');
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledOnce();
    expect(wrapper.get('[data-testid="current-chat-pane"]').element).toBe(pane);
    expect(wrapper.get('[data-testid="app-sidebar"]').element).toBe(sidebar);
  });
});
