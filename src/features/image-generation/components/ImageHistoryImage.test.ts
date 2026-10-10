import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { toBinaryObjectId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageHistoryImage from './ImageHistoryImage.vue';

const views: VueWrapper[] = [];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
  vi.restoreAllMocks();
});

it('invalidates every view of the deleted binary while preserving unrelated image elements and URLs', async () => {
  const deleted = toBinaryObjectId({ raw: 'deleted' }), other = toBinaryObjectId({ raw: 'other' });
  const getImage = vi.fn(async ({ binaryObjectId: _binaryObjectId }: { binaryObjectId: typeof deleted }) => new Blob(['PNG'], { type: 'image/png' }) as Blob | undefined);
  for (const binaryObjectId of [deleted, deleted, other]) {
    views.push(mount(ImageHistoryImage, { props: { binaryObjectId, width: 256, height: 256, alt: 'image', eager: true, getImage } }));
  }
  await flushPromises();
  const untouched = views[2]!.get('img').element;
  const untouchedUrl = untouched.getAttribute('src');
  getImage.mockImplementation(async ({ binaryObjectId }: { binaryObjectId: typeof deleted }) => binaryObjectId === deleted ? undefined : new Blob(['PNG']));
  for (const view of views) await view.setProps({ invalidation: { binaryObjectId: deleted, revision: 1 } });
  await flushPromises();
  expect(views[0]!.find('img').exists()).toBe(false);
  expect(views[1]!.find('img').exists()).toBe(false);
  expect(views[0]!.get('[role="status"]').text()).toContain('unavailable');
  expect(views[2]!.get('img').element).toBe(untouched);
  expect(views[2]!.get('img').attributes('src')).toBe(untouchedUrl);
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  expect(getImage).toHaveBeenCalledTimes(5);
  // A later deletion of another ID must not reload the previous missing image.
  for (const view of views) await view.setProps({ invalidation: { binaryObjectId: other, revision: 2 } });
  await flushPromises();
  expect(getImage).toHaveBeenCalledTimes(6);
});

it('does not restore a deleted image when an older file read resolves after invalidation', async () => {
  const binaryObjectId = toBinaryObjectId({ raw: 'deleted-during-read' });
  const read = Promise.withResolvers<Blob | undefined>();
  const getImage = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(undefined);
  const view = mount(ImageHistoryImage, { props: { binaryObjectId, width: 256, height: 256, alt: 'image', eager: true, getImage } });
  views.push(view);
  await flushPromises();
  await view.setProps({ invalidation: { binaryObjectId, revision: 1 } });
  await flushPromises();
  read.resolve(new Blob(['old image']));
  await flushPromises();
  expect(view.find('img').exists()).toBe(false);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(view.get('[role="status"]').text()).toContain('unavailable');
});
