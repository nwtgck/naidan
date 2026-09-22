// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blobForTransport, createBlobContext } from '@/utils/blob-view';
import { readNativeBlobRange } from '@/utils/blob-view-io';
import { validGguf, validGgufView } from './model-directory';

afterEach(() => vi.restoreAllMocks());

describe('GGUF view header validation', () => {
  it.each([
    { version: 2, size: 24, expected: true }, { version: 3, size: 128, expected: true },
    { version: 1, size: 24, expected: false }, { version: 4, size: 128, expected: false },
    { version: 3, size: 23, expected: false }, { version: 3, size: 8, expected: false },
    { version: 3, size: 0, expected: false },
  ])('matches the native policy for version $version and $size bytes', async ({ version, size, expected }) => {
    const bytes = new Uint8Array(size);
    if (size >= 8) {
      bytes.set([71, 71, 85, 70]); new DataView(bytes.buffer).setUint32(4, version, true);
    }
    const file = new File([bytes], 'model.gguf');
    const read = vi.fn(readNativeBlobRange); const blobs = createBlobContext({ reader: { read }, release: undefined });
    try {
      expect(await validGguf({ file })).toBe(expected);
      expect(await validGgufView({ blob: blobs.fromNative({ blob: file }), signal: new AbortController().signal })).toBe(expected);
      if (size < 24) expect(read).not.toHaveBeenCalled();
      else expect(read.mock.calls.map(([request]) => request.length)).toEqual([8]);
    } finally {
      blobs.dispose();
    }
  });

  it('rejects the wrong magic without accepting the version alone', async () => {
    const bytes = new Uint8Array(128); bytes[4] = 3;
    const blobs = createBlobContext({ reader: { read: readNativeBlobRange }, release: undefined });
    try {
      expect(await validGgufView({ blob: blobs.fromNative({ blob: new Blob([bytes]) }), signal: new AbortController().signal })).toBe(false);
    } finally {
      blobs.dispose();
    }
  });

  it('reads only eight bytes of a large model snapshot', async () => {
    const size = 2 ** 40;
    // Metadata-only test source: no terabyte buffer is allocated by the fixture.
    const source = { size, type: '', slice: vi.fn(() => new Blob([new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0])])) } as unknown as Blob;
    const read = vi.fn(readNativeBlobRange); const blobs = createBlobContext({ reader: { read }, release: undefined });
    try {
      const view = blobs.fromNative({ blob: source });
      expect(await validGgufView({ blob: view, signal: new AbortController().signal })).toBe(true);
      expect(source.slice).toHaveBeenCalledWith(0, 8, undefined);
      expect(read.mock.calls.map(([request]) => request.length)).toEqual([8]);
      expect(blobForTransport({ blob: view })).toBe(source);
    } finally {
      blobs.dispose();
    }
  });

  it.each(['short-read', 'read-error', 'abort'] as const)('never reports an inaccessible header as an invalid or valid file: %s', async reason => {
    const native = new Blob([new Uint8Array(128)]); const controller = new AbortController();
    const read = vi.fn(readNativeBlobRange);
    switch (reason) {
    case 'short-read': read.mockResolvedValue(new Uint8Array(7)); break;
    case 'read-error': read.mockRejectedValue(new DOMException('Snapshot failed', 'NotReadableError')); break;
    case 'abort': controller.abort(new DOMException('Stop', 'AbortError')); break;
    default: { const exhaustive: never = reason; throw new Error(String(exhaustive)); }
    }
    const blobs = createBlobContext({ reader: { read }, release: undefined });
    try {
      await expect(validGgufView({ blob: blobs.fromNative({ blob: native }), signal: controller.signal })).rejects.toThrow();
      if (reason === 'abort') expect(read).not.toHaveBeenCalled();
    } finally {
      blobs.dispose();
    }
  });
});
