import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, onUnmounted, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MainAppSurface from './MainAppSurface.vue';
import {
  useInitialRouteRenderReadinessClaim,
} from '@/logic/startup/initial-route-render-readiness';

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

const DeferredRoute = defineComponent({
  name: 'DeferredRoute',
  setup() {
    const readiness = useInitialRouteRenderReadinessClaim();
    onUnmounted(() => {
      readiness.cancel();
    });
    return {
      reportReady: readiness.reportReady,
      reportFailure: () => readiness.reportFailure({
        error: new Error('deferred route failed'),
      }),
    };
  },
  template: `
    <div>
      <button data-testid="deferred-route-ready" @click="reportReady" />
      <button data-testid="deferred-route-failure" @click="reportFailure" />
    </div>
  `,
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

  it('waits for an asynchronous initial route claim before reporting the shell ready', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: DeferredRoute },
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
    await flushPromises();

    expect(wrapper.emitted('initialShellRendered')).toBeUndefined();

    await wrapper.get('[data-testid="deferred-route-ready"]').trigger('click');
    await flushPromises();

    expect(wrapper.emitted('initialShellRendered')).toHaveLength(1);
  });

  it('reports failure when the current initial route cannot prepare', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: DeferredRoute },
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
    await flushPromises();

    await wrapper.get('[data-testid="deferred-route-failure"]').trigger('click');

    expect(wrapper.emitted('initialShellRenderFailed')).toHaveLength(1);
    expect(wrapper.emitted('initialShellRendered')).toBeUndefined();
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
    await flushPromises();

    expect(mountSpy).toHaveBeenCalledOnce();
    expect(wrapper.emitted('initialShellRendered')).toHaveLength(1);

    await router.push('/chat/chat-1');
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledOnce();

    await router.push('/chat/chat-2');
    expect(unmountSpy).not.toHaveBeenCalled();
    expect(mountSpy).toHaveBeenCalledOnce();
    expect(wrapper.emitted('initialShellRendered')).toHaveLength(1);
  });
});
