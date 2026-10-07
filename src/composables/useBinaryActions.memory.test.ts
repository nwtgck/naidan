import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBinaryActions } from './useBinaryActions';
import { storageService } from '@/00-storage/service';
import { toBinaryObjectId } from '@/01-models/ids';
import { TEST_ONLY } from '@/utils/stream-download';

vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));
vi.mock('./useImagePreview', () => ({ useImagePreview: () => ({ closePreview: vi.fn() }) }));
vi.mock('./useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));
const obj = { id: toBinaryObjectId({ raw: 'binary' }), name: 'local.bin' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.mocked(storageService.getFile).mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('downloads an empty in-memory Blob without trying storage', async () => {
  const memoryBlob = new Blob([]);
  await useBinaryActions().downloadBinaryObject({ obj, memoryBlob });
  expect(storageService.getFile).not.toHaveBeenCalled();
  expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(memoryBlob);
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(TEST_ONLY.DOWNLOAD_BLOB_RELEASE_DELAY_MS);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download');
  expect(document.querySelector('a[download]')).toBeNull();
});

it('releases the Blob URL and anchor even when the browser download click fails', async () => {
  const failure = new Error('blocked download');
  const anchors: HTMLAnchorElement[] = [];
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
    anchors.push(this);
    throw failure;
  });
  await expect(useBinaryActions().downloadBinaryObject({ obj, memoryBlob: new Blob(['x']) })).rejects.toBe(failure);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download');
  expect(anchors).toHaveLength(1);
  expect(anchors[0]?.isConnected).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not create an empty substitute when a persisted file is missing', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(null);
  await useBinaryActions().downloadBinaryObject({ obj, memoryBlob: undefined });
  expect(storageService.getFile).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: obj.id });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
