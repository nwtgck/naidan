import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserModelFileInput from './LlamaCppBrowserModelFileInput.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('shared model file input', () => {
  it('opens each native picker and gives concurrent inputs independent help references', async () => {
    const wrapper = mount(defineComponent({
      components: { LlamaCppBrowserModelFileInput },
      template: '<div><LlamaCppBrowserModelFileInput :disabled="false" mode="temp" layout="expanded" /><LlamaCppBrowserModelFileInput :disabled="false" mode="opfs" layout="compact" /></div>',
    }));
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const [first, second] = wrapper.findAllComponents(LlamaCppBrowserModelFileInput);
    if (!first || !second) {
      throw new Error('Both model inputs must be mounted in the same app');
    }
    const files = first.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]');
    const directory = first.get<HTMLInputElement>('[data-testid="llama-cpp-browser-directory"]');
    const fileClick = vi.spyOn(files.element, 'click').mockImplementation(() => {});
    const directoryClick = vi.spyOn(directory.element, 'click').mockImplementation(() => {});
    await first.get('[data-testid="llama-cpp-browser-choose-files"]').trigger('click');
    await first.get('[data-testid="llama-cpp-browser-choose-directory"]').trigger('click');
    expect(fileClick).toHaveBeenCalledOnce();
    expect(directoryClick).toHaveBeenCalledOnce();
    expect(directory.attributes('webkitdirectory')).toBeDefined();
    const help = files.attributes('aria-describedby');
    expect(first.find(`#${help}`).exists()).toBe(true);
    expect(second.get('[data-testid="llama-cpp-browser-file"]').attributes('aria-describedby')).not.toBe(help);
    expect(first.text()).toContain('reloaded or closed');
    expect(second.text()).toContain('after reloading');
  });

  it('keeps disabled drops isolated and clears any ancestor attachment overlay', async () => {
    const wrapper = mount(LlamaCppBrowserModelFileInput, { props: { disabled: true, mode: 'temp', layout: 'expanded' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const bubbled = vi.fn();
    wrapper.element.addEventListener('drop', bubbled);
    const zone = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]');
    await zone.trigger('dragenter', { dataTransfer: { types: ['Files'] } });
    expect(wrapper.emitted('drag-active')).toEqual([['idle']]);
    await zone.trigger('drop', { dataTransfer: { types: ['Files'], files: [new File(['x'], 'model.gguf')] } });
    expect(bubbled).not.toHaveBeenCalled();
    expect(wrapper.emitted('drop-files')).toBeUndefined();
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]').element.disabled).toBe(true);
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-directory"]').element.disabled).toBe(true);
  });

  it('keeps nested drag entries active until the whole zone is left', async () => {
    const wrapper = mount(LlamaCppBrowserModelFileInput, { props: { disabled: false, mode: 'temp', layout: 'expanded' } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const zone = wrapper.get('[data-testid="llama-cpp-browser-drop-zone"]');
    await zone.trigger('dragenter', { dataTransfer: { types: ['Files'] } });
    await zone.trigger('dragenter', { dataTransfer: { types: ['Files'] } });
    await zone.trigger('dragleave');
    expect(wrapper.emitted('drag-active')).toEqual([['active'], ['active']]);
    await zone.trigger('dragleave');
    expect(wrapper.emitted('drag-active')?.at(-1)).toEqual(['idle']);
  });
});

it('places a custom explanation below the drop instruction without repeating the mode description', () => {
  const explanation = 'Start without copying, then save it in your browser later.';
  const wrapper = mount(LlamaCppBrowserModelFileInput, { props: { disabled: false, mode: 'temp', layout: 'expanded', description: explanation } });
  using _cleanup = {
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(wrapper.find('[data-testid="llama-import-mode-description"]').exists()).toBe(false);
  const input = wrapper.get('[data-testid="llama-cpp-browser-file"]');
  expect(wrapper.get(`#${input.attributes('aria-describedby')}`).text()).toBe(explanation);
  expect(wrapper.text().split(explanation)).toHaveLength(2);
});
