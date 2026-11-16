import { beforeEach, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import AudioGenerationSidebar from './AudioGenerationSidebar.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture({ expanded, initial }: { expanded: boolean, initial: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/audio-generation', component: defineComponent({ render: () => undefined }) }] });
  await router.push(initial);
  await router.isReady();
  const wrapper = mount(AudioGenerationSidebar, { props: { expanded }, global: { plugins: [router] } });
  return {
    router,
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('keeps the three page sections reachable when collapsed without owning shared sidebar controls', async () => {
  using f = await fixture({ expanded: true, initial: '/audio-generation?settings=developer' });
  const links = f.wrapper.findAll('a');
  expect(links).toHaveLength(3);
  expect(f.wrapper.find('[data-testid="open-launcher"]').exists()).toBe(false);
  expect(f.wrapper.get('[data-testid="audio-nav-input"]').attributes('aria-current')).toBe('location');
  await f.wrapper.setProps({ expanded: false });
  for (const link of f.wrapper.findAll('a')) {
    expect(link.attributes('aria-label')).toBeTruthy();
    expect(link.attributes('title')).toBe(link.attributes('aria-label'));
    expect(link.attributes('href')).toContain('/audio-generation?settings=developer#audio-generation-');
  }
  await f.wrapper.get('[data-testid="audio-nav-results"]').trigger('click');
  await flushPromises();
  expect(f.router.currentRoute.value.fullPath).toBe('/audio-generation?settings=developer#audio-generation-results');
  expect(f.wrapper.get('[data-testid="audio-nav-results"]').attributes('aria-current')).toBe('location');
});

it('reopens and focuses the model section when its hash is selected again, preserving modified links', async () => {
  using f = await fixture({ expanded: false, initial: '/audio-generation#audio-generation-models' });
  const target = document.createElement('details'), summary = document.createElement('summary');
  target.id = 'audio-generation-models';
  summary.textContent = 'Models';
  target.append(summary);
  document.body.append(target);
  using section = {
    [Symbol.dispose]() {
      target.remove();
    },
  };
  const link = f.wrapper.get('[data-testid="audio-nav-models"]');
  // Suppress jsdom native navigation after the component has observed the modifier.
  link.element.addEventListener('click', event => event.preventDefault(), { once: true });
  await link.trigger('click', { ctrlKey: true });
  expect(target.open).toBe(false);
  await link.trigger('click');
  await flushPromises();
  expect(target.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(f.router.currentRoute.value.hash).toBe('#audio-generation-models');
  void section;
});
