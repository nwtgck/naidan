import { afterEach, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import ImageRepositoryImport from './ImageRepositoryImport.vue';
import { createDisabledImageLibrary } from '@/features/stable-diffusion-cpp-browser/library-standalone';

afterEach(() => vi.restoreAllMocks());

it('advertises copy while idle and none while busy; drop is not controlled by truthy Ref objects', async () => {
  const downloading = ref(false), importing = ref(false);
  const view = { ...createDisabledImageLibrary(), downloading: computed(() => downloading.value), importing: computed(() => importing.value), dropDirectory: vi.fn(async () => undefined) };
  const wrapper = mount(ImageRepositoryImport, { props: { view, disabled: false } });
  try {
    const zone = wrapper.get('[data-testid="image-repository-drop"]');
    const transfer = { dropEffect: 'none', types: ['Files'] };
    await zone.trigger('dragover', { dataTransfer: transfer }); expect(transfer.dropEffect).toBe('copy');
    downloading.value = true; await zone.trigger('dragover', { dataTransfer: transfer }); expect(transfer.dropEffect).toBe('none');
    await zone.trigger('drop', { dataTransfer: transfer }); expect(view.dropDirectory).not.toHaveBeenCalled();
    downloading.value = false; await zone.trigger('drop', { dataTransfer: transfer }); expect(view.dropDirectory).toHaveBeenCalledOnce();
    importing.value = true; await zone.trigger('dragover', { dataTransfer: transfer }); expect(transfer.dropEffect).toBe('none');
  } finally {
    wrapper.unmount();
  }
});

it('keeps an active import cancellable when an independent operation blocks new imports', async () => {
  const view = { ...createDisabledImageLibrary(), importing: computed(() => true), cancelImport: vi.fn(), dropDirectory: vi.fn(async () => undefined) };
  const wrapper = mount(ImageRepositoryImport, { props: { view, disabled: true } });
  try {
    const cancel = wrapper.get<HTMLButtonElement>('[data-testid="image-cancel-import"]');
    expect(cancel.element.disabled).toBe(false);
    await cancel.trigger('click');
    expect(view.cancelImport).toHaveBeenCalledOnce();
    expect(wrapper.get<HTMLInputElement>('input[type="file"]').element.disabled).toBe(true);
    expect(view.dropDirectory).not.toHaveBeenCalled();
  } finally {
    wrapper.unmount();
  }
});

it('keeps standalone import actions disabled when no import can be in progress', () => {
  const wrapper = mount(ImageRepositoryImport, { props: { view: createDisabledImageLibrary(), disabled: true } });
  try {
    expect(wrapper.get<HTMLInputElement>('input[type="file"]').element.disabled).toBe(true);
    expect(wrapper.find('[data-testid="image-cancel-import"]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});
