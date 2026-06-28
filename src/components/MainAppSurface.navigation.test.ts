import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MainAppSurface from './MainAppSurface.vue';

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

vi.mock('@/components/Sidebar.vue', () => ({
  default: {
    template: '<div data-testid="sidebar" />',
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

    mount(MainAppSurface, {
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

    expect(mountSpy).toHaveBeenCalledOnce();

    await router.push('/chat/chat-1');
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledOnce();

    await router.push('/chat/chat-2');
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledOnce();
  });
});
