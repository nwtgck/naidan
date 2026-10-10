import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { createRouter, createMemoryHistory, START_LOCATION } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelLaunchOnboardingBypass } from './useModelLaunchOnboardingBypass';
const loadMeta = vi.fn();
const loadChatGroup = vi.fn();
const storageType = ref('memory');
let storageCurrent = true;
vi.mock('@/00-storage/service', () => ({ storageService: { loadChatMeta: (args: unknown) => loadMeta(args), loadChatGroup: (args: unknown) => loadChatGroup(args), captureModelLaunchStorage: () => () => storageCurrent } }));

beforeEach(() => {
  vi.clearAllMocks(); loadMeta.mockResolvedValue(null); loadChatGroup.mockResolvedValue(null); storageType.value = 'memory'; storageCurrent = true;
});

async function mountBypass({ path }: { path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/chat/:id', component: { template: '<div />' } }] });
  await router.push(path);
  const wrapper = mount(defineComponent({
    setup() {
      return { bypass: useModelLaunchOnboardingBypass({ initialized: ref(true), storageType }) };
    },
    template: '<div>{{ bypass }}</div>',
  }), { global: { plugins: [router] } });
  return { router, wrapper };
}

describe('model launch onboarding presentation', () => {
  it('bypasses the blocking modal at the root link and restores normal presentation when leaving', async () => {
    const { wrapper, router } = await mountBypass({ path: '/?llama-cpp-browser-model=owner/model' });
    expect(wrapper.text()).toBe('true'); expect(loadMeta).not.toHaveBeenCalled();
    await router.push('/'); await flushPromises(); expect(wrapper.text()).toBe('false'); wrapper.unmount();
  });

  it('restores the same presentation from a saved launch chat without retaining a parameter', async () => {
    loadMeta.mockResolvedValue({ groupId: 'cg' });
    loadChatGroup.mockResolvedValue({ endpoint: { type: 'llama_cpp_browser' }, modelId: 'hf.co/owner/repo:model.gguf' });
    const { wrapper } = await mountBypass({ path: '/chat/saved' }); await flushPromises();
    expect(wrapper.text()).toBe('true'); wrapper.unmount();
  });

  it('does not allow a stale provider to keep bypassing onboarding', async () => {
    const pending = Promise.withResolvers<unknown>(); loadMeta.mockReturnValueOnce(pending.promise);
    const { wrapper } = await mountBypass({ path: '/chat/slow' }); await flushPromises();
    storageType.value = 'local'; await flushPromises();
    pending.resolve({ endpoint: { type: 'llama_cpp_browser' }, modelId: 'model' }); await flushPromises();
    expect(wrapper.text()).toBe('false'); wrapper.unmount();
  });

  it('does not permanently bypass onboarding for an unrelated or missing chat', async () => {
    const { wrapper } = await mountBypass({ path: '/chat/unrelated' }); await flushPromises();
    expect(wrapper.text()).toBe('false'); wrapper.unmount();
  });

  it('ignores a saved chat read which finishes after navigation away', async () => {
    const pending = Promise.withResolvers<unknown>(); loadMeta.mockReturnValueOnce(pending.promise);
    const { wrapper, router } = await mountBypass({ path: '/chat/slow' }); await router.push('/');
    pending.resolve({ endpoint: { type: 'llama_cpp_browser' }, modelId: 'model' }); await flushPromises(); expect(wrapper.text()).toBe('false'); wrapper.unmount();
  });
});

describe('initial model-link navigation', () => {
  it('suppresses onboarding before the initial router navigation completes', async () => {
    const history = createMemoryHistory(); history.replace('/?llama-cpp-browser-model=owner/model');
    const router = createRouter({ history, routes: [{ path: '/', component: { template: '<div />' } }] });
    const guard = Promise.withResolvers<boolean>(); router.beforeEach(() => guard.promise);
    expect(router.currentRoute.value).toBe(START_LOCATION);
    const wrapper = mount(defineComponent({
      setup() {
        return { bypass: useModelLaunchOnboardingBypass({ initialized: ref(true), storageType }) };
      },
      template: '<div>{{ bypass }}</div>',
    }), { global: { plugins: [router] } });
    expect(wrapper.text()).toBe('true'); expect(loadMeta).not.toHaveBeenCalled();
    guard.resolve(true); await router.isReady(); await flushPromises();
    expect(wrapper.text()).toBe('true'); wrapper.unmount();
  });
});
