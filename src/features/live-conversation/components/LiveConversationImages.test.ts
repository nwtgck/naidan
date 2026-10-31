import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { toBinaryObjectId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { downloadBlob } from '@/utils/stream-download';
import type { LiveTurnImage } from '@/features/live-conversation/logic/controller';
import LiveConversationImages from './LiveConversationImages.vue';

vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));
vi.mock('@/utils/stream-download', () => ({ downloadBlob: vi.fn() }));

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

function image({ id, name }: { id: string, name: string }): LiveTurnImage {
  return { id: toBinaryObjectId({ raw: id }), name, blob: new Blob([id], { type: 'image/png' }), createdAt: 1 };
}

function fixture({ images }: { images: LiveTurnImage[] }) {
  let serial = 0;
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:live-image-${++serial}`);
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(LiveConversationImages, { props: { images }, attachTo: host });
  const page = new DOMWrapper(document.body);
  return {
    wrapper,
    page,
    createUrl,
    revokeUrl,
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

describe('shared image preview for live messages', () => {
  it('opens and downloads original memory bytes without accessing persistent storage', async () => {
    const first = image({ id: 'first', name: 'first.png' });
    using f = fixture({ images: [first] });
    expect(f.wrapper.get('img').attributes('src')).toBe('blob:live-image-1');
    await f.wrapper.get('[data-testid="live-image-preview"]').trigger('click');
    await flushPromises();
    expect(f.page.get('[data-testid="preview-image"]').attributes('src')).toBe('blob:live-image-2');
    expect(f.createUrl).toHaveBeenLastCalledWith(first.blob);
    expect(storageService.getFile).not.toHaveBeenCalled();
    expect(f.page.get('[data-testid="preview-delete-btn"]').attributes('disabled')).toBeDefined();
    await f.page.get('[data-testid="preview-download-btn"]').trigger('click');
    expect(downloadBlob).toHaveBeenCalledWith({ blob: first.blob, filename: first.name });
  });

  it('navigates repeated filenames by identity with the existing viewer', async () => {
    const a = image({ id: 'a', name: 'same.png' });
    const b = image({ id: 'b', name: 'same.png' });
    using f = fixture({ images: [a, b] });
    await f.wrapper.findAll('[data-testid="live-image-preview"]')[0]!.trigger('click');
    await flushPromises();
    expect(f.createUrl).toHaveBeenLastCalledWith(a.blob);
    await f.page.get('[data-testid="preview-next-btn"]').trigger('click');
    await flushPromises();
    expect(f.createUrl).toHaveBeenLastCalledWith(b.blob);
    await f.page.get('[data-testid="preview-prev-btn"]').trigger('click');
    await flushPromises();
    expect(f.createUrl).toHaveBeenLastCalledWith(a.blob);
    expect(storageService.getFile).not.toHaveBeenCalled();
  });

  it('does not churn thumbnail URLs when conversation text or status changes', async () => {
    const a = image({ id: 'a', name: 'a.png' });
    using f = fixture({ images: [a] });
    await f.wrapper.setProps({ images: [a] });
    await f.wrapper.setProps({ images: [a] });
    expect(f.createUrl).toHaveBeenCalledTimes(1);
    expect(f.revokeUrl).not.toHaveBeenCalled();
  });

  it('closes the preview and revokes both kinds of URLs when the conversation is cleared', async () => {
    using f = fixture({ images: [image({ id: 'a', name: 'a.png' })] });
    await f.wrapper.get('[data-testid="live-image-preview"]').trigger('click');
    await flushPromises();
    await f.wrapper.setProps({ images: [] });
    await flushPromises();
    expect(f.page.find('[data-testid="preview-image"]').exists()).toBe(false);
    expect(f.revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual(['blob:live-image-1', 'blob:live-image-2']);
  });

  it('releases thumbnails and an open preview when the message unmounts', async () => {
    using f = fixture({ images: [image({ id: 'a', name: 'a.png' }), image({ id: 'b', name: 'b.png' })] });
    await f.wrapper.findAll('[data-testid="live-image-preview"]')[0]!.trigger('click');
    await flushPromises();
    f.wrapper.unmount();
    await flushPromises();
    expect(f.revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual(['blob:live-image-1', 'blob:live-image-2', 'blob:live-image-3']);
    expect(f.page.find('[data-testid="preview-image"]').exists()).toBe(false);
  });

  it('keeps a filename preview action when a thumbnail URL cannot be made', async () => {
    using f = fixture({ images: [] });
    f.createUrl.mockImplementationOnce(() => {
      throw new Error('URL unavailable');
    });
    const a = image({ id: 'a', name: 'still-available.png' });
    await f.wrapper.setProps({ images: [a] });
    expect(f.wrapper.find('img').exists()).toBe(false);
    expect(f.wrapper.text()).toContain(a.name);
    await f.wrapper.get('[data-testid="live-image-preview"]').trigger('click');
    await flushPromises();
    expect(f.page.find('[data-testid="preview-image"]').exists()).toBe(true);
    expect(storageService.getFile).not.toHaveBeenCalled();
  });

  it('restores thumbnail focus after Escape and never treats a filename as markup', async () => {
    using f = fixture({ images: [image({ id: 'a', name: '<script>bad()</script>.png' })] });
    const trigger = f.wrapper.get<HTMLButtonElement>('[data-testid="live-image-preview"]');
    trigger.element.focus();
    await trigger.trigger('click');
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flushPromises();
    expect(document.activeElement).toBe(trigger.element);
    expect(f.page.find('[data-testid="preview-image"]').exists()).toBe(false);
    expect(f.wrapper.find('script').exists()).toBe(false);
  });
});
