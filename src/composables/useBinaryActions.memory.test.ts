import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useBinaryActions } from './useBinaryActions';
import { storageService } from '@/00-storage/service';
import { toBinaryObjectId } from '@/01-models/ids';

vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));
vi.mock('./useImagePreview', () => ({ useImagePreview: () => ({ closePreview: vi.fn() }) }));
vi.mock('./useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));
const obj = { id: toBinaryObjectId({ raw: 'binary' }), name: 'local.bin' };
beforeEach(() => {
  vi.mocked(storageService.getFile).mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
it('downloads an empty in-memory Blob without trying storage', async () => {
  const memoryBlob = new Blob([]);
  await useBinaryActions().downloadBinaryObject({ obj, memoryBlob });
  expect(storageService.getFile).not.toHaveBeenCalled();
  expect(URL.createObjectURL).toHaveBeenCalledExactlyOnceWith(memoryBlob);
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download');
});
it('releases the Blob URL and anchor even when the browser download click fails', async () => {
  const failure = new Error('blocked download');
  const removed = vi.spyOn(document.body, 'removeChild');
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(() => {
    throw failure;
  });
  await expect(useBinaryActions().downloadBinaryObject({ obj, memoryBlob: new Blob(['x']) })).rejects.toBe(failure);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:download');
  expect(removed).toHaveBeenCalledOnce();
});
it('does not create an empty substitute when a persisted file is missing', async () => {
  vi.mocked(storageService.getFile).mockResolvedValue(null);
  await useBinaryActions().downloadBinaryObject({ obj, memoryBlob: undefined });
  expect(storageService.getFile).toHaveBeenCalledExactlyOnceWith({ binaryObjectId: obj.id });
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
});
