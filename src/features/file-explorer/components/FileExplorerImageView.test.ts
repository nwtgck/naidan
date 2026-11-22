import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerImageView from './FileExplorerImageView.vue';

const { editedBlob } = vi.hoisted(() => ({ editedBlob: new Blob(['edited image'], { type: 'image/jpeg' }) }));

vi.mock('@/components/ImageEditor.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    __esModule: true,
    default: defineComponent({
      props: {
        imageUrl: String,
        fileName: String,
        originalMimeType: String,
        initialOutputFormat: String,
      },
      emits: ['save', 'cancel'],
      setup: (props, { emit }) => () => h('div', {
        'data-testid': 'test-image-editor',
        'data-image-url': props.imageUrl,
        'data-file-name': props.fileName,
        'data-original-mime-type': props.originalMimeType,
        'data-output-format': props.initialOutputFormat,
      }, [
        h('button', { 'data-testid': 'test-editor-cancel', onClick: () => emit('cancel') }, 'Cancel'),
        h('button', { 'data-testid': 'test-editor-save', onClick: () => emit('save', { blob: editedBlob }) }, 'Save'),
      ]),
    }),
  };
});

let wrapper: VueWrapper<InstanceType<typeof FileExplorerImageView>> | undefined;
const props = { url: 'blob:original', fileName: 'photo.jpg', mimeType: 'image/jpeg', canSave: true };

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

function pointerEvent({ type, x, y }: { type: string, x: number, y: number }): Event {
  return Object.assign(new Event(type, { bubbles: true }), {
    pointerId: 1,
    button: 0,
    clientX: x,
    clientY: y,
  });
}

function editorDialog() {
  const element = document.querySelector<HTMLElement>('[data-testid="file-explorer-image-editor-dialog"]');
  if (!element) {
    throw new Error('The image editor did not open');
  }
  return new DOMWrapper(element);
}

it('fits, zooms and pans a read-only image without enabling edit', async () => {
  wrapper = mount(FileExplorerImageView, { props: { ...props, canSave: false } });
  const image = wrapper.get('img');
  expect(image.attributes('alt')).toBe(props.fileName);
  await image.trigger('load');
  expect(wrapper.get('[data-testid="file-explorer-edit-image"]').element.matches(':disabled')).toBe(true);

  const stage = wrapper.get<HTMLElement>('[data-testid="file-explorer-image-stage"]');
  stage.element.setPointerCapture = vi.fn();
  await wrapper.get('[data-testid="file-explorer-image-zoom-in"]').trigger('click');
  stage.element.dispatchEvent(pointerEvent({ type: 'pointerdown', x: 10, y: 20 }));
  stage.element.dispatchEvent(pointerEvent({ type: 'pointermove', x: 35, y: 24 }));
  stage.element.dispatchEvent(pointerEvent({ type: 'pointerup', x: 35, y: 24 }));
  stage.element.dispatchEvent(pointerEvent({ type: 'pointermove', x: 50, y: 50 }));
  await nextTick();

  const imageTransform = wrapper.get<HTMLElement>('[data-testid="file-explorer-image-transform"]');
  expect(imageTransform.element.style.transform).toBe('translate(25px, 4px) scale(1.25)');
  await wrapper.get('[data-testid="file-explorer-image-fit"]').trigger('click');
  expect(imageTransform.element.style.transform).toBe('translate(0px, 0px) scale(1)');
});

it('opens the existing editor focused with the original format, then restores focus on cancel', async () => {
  wrapper = mount(FileExplorerImageView, { props, attachTo: document.body });
  const edit = wrapper.get<HTMLButtonElement>('[data-testid="file-explorer-edit-image"]');
  expect(edit.element.disabled).toBe(true);
  await wrapper.get('img').trigger('load');
  edit.element.focus();
  await edit.trigger('click');

  const dialog = editorDialog();
  expect(document.activeElement).toBe(dialog.element);
  await vi.waitFor(() => expect(dialog.find('[data-testid="test-image-editor"]').exists()).toBe(true));
  expect(dialog.get('[data-testid="test-image-editor"]').attributes()).toMatchObject({
    'data-image-url': props.url,
    'data-file-name': props.fileName,
    'data-original-mime-type': props.mimeType,
    'data-output-format': 'original',
  });
  await dialog.trigger('keydown', { key: 'Tab' });
  const cancel = dialog.get('[data-testid="test-editor-cancel"]');
  expect(document.activeElement).toBe(cancel.element);
  await cancel.trigger('click');
  expect(document.activeElement).toBe(edit.element);
  expect(wrapper.emitted('save')).toBeUndefined();
  expect(wrapper.get('img').attributes('src')).toBe(props.url);
});

it('emits the edited Blob and disables editing when the next source fails to load', async () => {
  wrapper = mount(FileExplorerImageView, { props });
  await wrapper.get('img').trigger('load');
  await wrapper.get('[data-testid="file-explorer-edit-image"]').trigger('click');
  const dialog = editorDialog();
  await vi.waitFor(() => expect(dialog.find('[data-testid="test-editor-save"]').exists()).toBe(true));
  await dialog.get('[data-testid="test-editor-save"]').trigger('click');
  expect(wrapper.emitted('save')).toEqual([[{ blob: editedBlob }]]);
  expect(wrapper.get('img').attributes('src')).toBe(props.url);

  await wrapper.setProps({ url: 'blob:broken' });
  await wrapper.get('img').trigger('error');
  expect(wrapper.get('[role="alert"]').text()).toBe('Could not load the image.');
  expect(wrapper.get('[data-testid="file-explorer-edit-image"]').element.matches(':disabled')).toBe(true);
});
