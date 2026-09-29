import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageService } from '@/00-storage/service';
import { toBinaryObjectId } from '@/01-models/ids';
import { downloadBlob } from '@/utils/stream-download';
import { embedMetadataInPng } from '@/utils/image-metadata';
import { ImageDownloadHydrator } from './ImageDownloadHydrator';

vi.mock('@/utils/stream-download', () => ({ downloadBlob: vi.fn() }));
vi.mock('@/utils/image-metadata', () => ({
  detectFormat: vi.fn(), UNSUPPORTED: 'unsupported',
  embedMetadataInPng: vi.fn(), embedMetadataInWebp: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

describe('image download Blob ownership', () => {
  it.each([false, true])('reuses the final Blob without rebuffering (metadata: %s)', async withMetadata => {
    const original = new Blob(['image'], { type: 'image/png' });
    const embedded = new Blob(['image with metadata'], { type: 'image/png' });
    vi.mocked(embedMetadataInPng).mockResolvedValue(embedded);
    const getFile = vi.fn();
    const getBinaryObject = vi.fn();
    const onError = vi.fn();
    await ImageDownloadHydrator.download({
      id: toBinaryObjectId({ raw: 'image-test' }), name: 'image.png', memoryBlob: original,
      prompt: 'scene', steps: undefined, seed: undefined, model: undefined, withMetadata,
      storageService: { getFile, getBinaryObject } as unknown as StorageService, onError,
    });
    expect(downloadBlob).toHaveBeenCalledExactlyOnceWith({ blob: withMetadata ? embedded : original, filename: 'scene.png' });
    expect(getFile).not.toHaveBeenCalled();
    expect(getBinaryObject).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.mocked(downloadBlob).mock.calls[0]?.[0].blob).toBe(withMetadata ? embedded : original);
  });
});
