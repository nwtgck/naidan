import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import TranslationPage from '@/pages/translation.vue';
import TranslationModelsRoute from '@/pages/translation/models.vue';

const lifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock('./TranslationWorkspace.vue', () => ({
  __esModule: true,
  default: {
    props: ['tab'],
    emits: ['openWorkspace', 'openModels'],
    data: () => ({ draft: '' }),
    mounted: lifecycle.mounted,
    unmounted: lifecycle.unmounted,
    template: `<section><input data-testid="route-draft" v-model="draft" /><span data-testid="route-tab">{{ tab }}</span><button data-testid="route-models" @click="$emit('openModels')">Models</button><button data-testid="route-workspace" @click="$emit('openWorkspace')">Workspace</button></section>`,
  },
}));

beforeEach(() => {
  lifecycle.mounted.mockClear();
  lifecycle.unmounted.mockClear();
});

async function fixture({ path }: { path: string }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<p>Chats</p>' } },
      { path: '/translation', component: TranslationPage, children: [{ path: 'models', component: TranslationModelsRoute }] },
    ],
  });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(RouterView, { global: { plugins: [router] } });
  return {
    router,
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('translation route ownership', () => {
  it('retains one workspace and its private draft while changing nested model routes', async () => {
    using f = await fixture({ path: '/translation?settings=connection' });
    await f.wrapper.get('[data-testid="route-draft"]').setValue('private draft');
    await f.wrapper.get('[data-testid="route-models"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/translation/models');
    expect(f.router.currentRoute.value.query).toEqual({ settings: 'connection' });
    expect(f.wrapper.get('[data-testid="route-tab"]').text()).toBe('models');
    await f.wrapper.get('[data-testid="route-workspace"]').trigger('click');
    await flushPromises();
    expect(f.router.currentRoute.value.path).toBe('/translation');
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="route-draft"]').element.value).toBe('private draft');
    expect(lifecycle.mounted).toHaveBeenCalledOnce();
    expect(lifecycle.unmounted).not.toHaveBeenCalled();
    await f.router.push('/');
    expect(lifecycle.unmounted).toHaveBeenCalledOnce();
    await f.router.push('/translation');
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="route-draft"]').element.value).toBe('');
  });

  it('opens the model tab directly without requiring a previous workspace visit', async () => {
    using f = await fixture({ path: '/translation/models' });
    expect(f.wrapper.get('[data-testid="route-tab"]').text()).toBe('models');
    expect(lifecycle.mounted).toHaveBeenCalledOnce();
  });
});
