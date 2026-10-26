// @vitest-environment node
import { gzipSync, gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createGzipAsset } from './gzip-asset';

describe('lazy compressed runtime assets', () => {
  it('reads only on demand and shares compression with identical hosted bytes', async () => {
    const source = Buffer.from('verified runtime bytes');
    const read = vi.fn(() => source);
    const asset = createGzipAsset({ read });
    expect(read).not.toHaveBeenCalled();
    const first = asset();
    expect(asset()).toBe(first);
    const bytes = await first;
    expect(Buffer.from(bytes)).toEqual(gzipSync(source, { level: 9 }));
    expect(gunzipSync(bytes)).toEqual(source);
    expect(await asset()).toBe(bytes);
    expect(read).toHaveBeenCalledOnce();
  });

  it('reports verification failures to every caller and retries corrected input', async () => {
    const failure = new Error('Artifact integrity mismatch');
    const source = Buffer.from('corrected runtime bytes');
    const read = vi.fn<() => Uint8Array>().mockImplementationOnce(() => {
      throw failure;
    }).mockReturnValue(source);
    const asset = createGzipAsset({ read });
    const first = asset();
    const second = asset();
    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(gunzipSync(await asset())).toEqual(source);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
