import { afterEach, beforeEach, expect, it } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
let wrapper: VueWrapper<InstanceType<typeof ImageGenerationViewer>> | undefined;

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
});

it('supports explicit zoom, keyboard next/previous and closing without owning image storage', async () => {
  wrapper = mount(ImageGenerationViewer, { props: { downloadEnabled: true, count: 3, index: 0, 'onUpdate:index': value => wrapper?.setProps({ index: value }) }, global: { stubs: { Teleport: true } } });
  await wrapper.get('[data-testid="image-viewer-zoom-in"]').trigger('click');
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1.25);
  await wrapper.get('[data-testid="image-viewer"]').trigger('keydown', { key: 'ArrowRight' });
  expect(wrapper.props('index')).toBe(1);
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1);
  await wrapper.get('[data-testid="image-viewer"]').trigger('keydown', { key: 'ArrowLeft' });
  expect(wrapper.props('index')).toBe(0);
  expect(wrapper.get('[data-testid="image-viewer-previous"]').element.matches(':disabled')).toBe(true);
  await wrapper.get('[data-testid="image-viewer"]').trigger('keydown', { key: 'Escape' });
  expect(wrapper.emitted('close')).toHaveLength(1);
});

it('does not offer a PNG download for input images when the caller disables it', () => {
  wrapper = mount(ImageGenerationViewer, { props: { count: 1, index: 0, downloadEnabled: false }, global: { stubs: { Teleport: true } } });
  expect(wrapper.text()).not.toContain('Download PNG');
});

it('keeps the photograph unobstructed until details are requested and retains zoom while toggling details', async () => {
  wrapper = mount(ImageGenerationViewer, { props: { count: 2, index: 0, downloadEnabled: false }, slots: { details: '<textarea data-testid="details-prompt">editable prompt</textarea>' }, global: { stubs: { Teleport: true } } });
  expect(wrapper.find('[data-image-viewer-details]').exists()).toBe(false);
  await wrapper.get('[data-testid="image-viewer-zoom-in"]').trigger('click');
  await wrapper.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
  expect(wrapper.get('[data-testid="image-viewer-details-toggle"]').attributes('aria-expanded')).toBe('true');
  expect(wrapper.find('[data-testid="details-prompt"]').exists()).toBe(true);
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1.25);
  await wrapper.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
  expect(wrapper.find('[data-image-viewer-details]').exists()).toBe(false);
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1.25);
});

it('leaves editing, selection and modified arrow keys to the control instead of changing images', async () => {
  wrapper = mount(ImageGenerationViewer, {
    props: { count: 3, index: 1, downloadEnabled: false },
    slots: { toolbar: '<input data-testid="toolbar-input">', details: '<div><textarea data-testid="details-prompt"/><select data-testid="tag-picker"><option>a</option></select><button data-testid="details-action">assign</button></div>' },
    global: { stubs: { Teleport: true } },
  });
  await wrapper.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
  for (const selector of ['toolbar-input', 'details-prompt', 'tag-picker']) {
    await wrapper.get(`[data-testid="${selector}"]`).trigger('keydown', { key: 'ArrowRight' });
    await wrapper.get(`[data-testid="${selector}"]`).trigger('keydown', { key: 'ArrowLeft' });
  }
  const dialog = wrapper.get('[data-testid="image-viewer"]');
  await dialog.trigger('keydown', { key: 'ArrowRight', ctrlKey: true });
  await dialog.trigger('keydown', { key: 'ArrowLeft', metaKey: true });
  await dialog.trigger('keydown', { key: 'ArrowLeft', isComposing: true });
  expect(wrapper.emitted('update:index')).toBeUndefined();
  await dialog.trigger('keydown', { key: 'ArrowRight' });
  expect(wrapper.emitted('update:index')).toEqual([[2]]);
});

it('does not consume Escape already handled by a control or by an IME', async () => {
  wrapper = mount(ImageGenerationViewer, { props: { count: 1, index: 0, downloadEnabled: false }, global: { stubs: { Teleport: true } } });
  const dialog = wrapper.get('[data-testid="image-viewer"]');
  const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  handled.preventDefault(); dialog.element.dispatchEvent(handled);
  await dialog.trigger('keydown', { key: 'Escape', isComposing: true });
  expect(wrapper.emitted('close')).toBeUndefined();
  await dialog.trigger('keydown', { key: 'Escape' }); expect(wrapper.emitted('close')).toHaveLength(1);
});

it('traps focus across editable details and links, then restores the opener on close', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus();
  try {
    wrapper = mount(ImageGenerationViewer, {
      props: { count: 1, index: 0, downloadEnabled: false },
      slots: { details: '<div><input disabled><input hidden><a href="#details" data-testid="details-link">Details</a><textarea data-testid="details-last"/><details><summary>Collapsed</summary><input data-testid="hidden-input"></details></div>' },
    });
    const element = document.querySelector<HTMLElement>('[data-testid="image-viewer"]')!;
    const dialog = new DOMWrapper(element);
    expect(document.activeElement).toBe(element);
    await dialog.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
    // Use the real Teleport: the test-utils Teleport stub remounts its slot.
    expect(element.isConnected).toBe(true);
    await dialog.trigger('keydown', { key: 'Tab' });
    const first = dialog.findAll<HTMLButtonElement>('button').find(button => !button.element.disabled)!;
    expect(document.activeElement).toBe(first.element);
    first.element.focus(); await first.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.tagName).toBe('SUMMARY');
    expect(document.activeElement).not.toBe(dialog.get('[data-testid="hidden-input"]').element);
    await dialog.get('summary').trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first.element);
    wrapper.unmount(); wrapper = undefined;
    expect(document.activeElement).toBe(opener);
  } finally {
    opener.remove();
  }
});

it('changes wheel zoom only over the image stage, never over scrollable metadata', async () => {
  wrapper = mount(ImageGenerationViewer, { props: { count: 1, index: 0, downloadEnabled: false }, slots: { details: '<div data-testid="long-details">parameters</div>' }, global: { stubs: { Teleport: true } } });
  await wrapper.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
  await wrapper.get('[data-testid="long-details"]').trigger('wheel', { deltaY: -100 });
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1);
  await wrapper.get('[data-testid="image-viewer-stage"]').trigger('wheel', { deltaY: -100 });
  expect(wrapper.vm.TEST_ONLY.zoom.value).toBe(1.1);
});

it('navigates with arrow keys while a details action has focus, just as the image toolbar does', async () => {
  wrapper = mount(ImageGenerationViewer, {
    props: { count: 3, index: 1, downloadEnabled: false, 'onUpdate:index': value => wrapper?.setProps({ index: value }) },
    slots: { details: '<button data-testid="details-action">Add tag</button>' },
    global: { stubs: { Teleport: true } },
  });
  await wrapper.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
  await wrapper.get('[data-testid="details-action"]').trigger('keydown', { key: 'ArrowRight' });
  expect(wrapper.props('index')).toBe(2);
  await wrapper.get('[data-testid="details-action"]').trigger('keydown', { key: 'ArrowLeft' });
  expect(wrapper.props('index')).toBe(1);
});
