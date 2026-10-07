// @vitest-environment node
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createVerifiedImageModelFiles } from './verified-image-model-files';

function file({ text }: { text: string }): File {
  return new File([text], 'model.gguf', { lastModified: 123 });
}
async function prepared({ cache, value, key, signal }: {
  cache: ReturnType<typeof createVerifiedImageModelFiles>; value: File; key: string; signal: AbortSignal;
}) {
  return cache.prepare({ signal, files: [{ key, file: value, expectedSha256: undefined }] });
}

it('reuses the original File only after verifying the fresh content and the retained snapshot', async () => {
  const cache = createVerifiedImageModelFiles(), signal = new AbortController().signal;
  const original = file({ text: 'weights' });
  (await prepared({ cache, value: original, key: 'root/model', signal })).commit();
  const fresh = file({ text: 'weights' }), snapshot = await prepared({ cache, value: fresh, key: 'root/model', signal });
  expect(snapshot.replacements.get(fresh)).toBe(original);
});

it('same size, timestamp and path cannot hide changed content, even on the original File object', async () => {
  const cache = createVerifiedImageModelFiles(), signal = new AbortController().signal;
  const original = file({ text: 'old data' });
  (await prepared({ cache, value: original, key: 'root/model', signal })).commit();
  const changed = file({ text: 'new data' });
  // Simulate a browser disk snapshot exposing new bytes without updating its metadata.
  vi.spyOn(original, 'slice').mockImplementation((start, end) => changed.slice(start, end));
  expect((await prepared({ cache, value: changed, key: 'root/model', signal })).replacements.get(changed)).toBe(changed);
  const sameObject = await prepared({ cache, value: original, key: 'root/model', signal });
  expect(sameObject.replacements.get(original)).not.toBe(original);
  expect(await sameObject.replacements.get(original)?.text()).toBe('new data');
  // A current replacement never silently restores the old cached snapshot for a new File.
  sameObject.commit();
  const newer = file({ text: 'old data' });
  expect((await prepared({ cache, value: newer, key: 'root/model', signal })).replacements.get(newer)).toBe(newer);
});

it('uses a fresh File when the previous snapshot is unreadable, and rejects an unreadable fresh file', async () => {
  const cache = createVerifiedImageModelFiles(), signal = new AbortController().signal, original = file({ text: 'weights' });
  (await prepared({ cache, value: original, key: 'root/model', signal })).commit();
  vi.spyOn(original, 'slice').mockImplementation(() => {
    throw new DOMException('stale snapshot', 'NotReadableError');
  });
  const fresh = file({ text: 'weights' });
  expect((await prepared({ cache, value: fresh, key: 'root/model', signal })).replacements.get(fresh)).toBe(fresh);
  await expect(prepared({ cache, value: original, key: 'root/model', signal })).rejects.toMatchObject({ name: 'NotReadableError' });
});

it('retains only the last committed configuration and keeps roots and members distinct', async () => {
  const cache = createVerifiedImageModelFiles(), signal = new AbortController().signal, first = file({ text: 'weights' });
  (await prepared({ cache, value: first, key: 'root-a/model', signal })).commit();
  const other = file({ text: 'weights' });
  const next = await prepared({ cache, value: other, key: 'root-b/model', signal });
  expect(next.replacements.get(other)).toBe(other); next.commit();
  const former = file({ text: 'weights' });
  expect((await prepared({ cache, value: former, key: 'root-a/model', signal })).replacements.get(former)).toBe(former);
  cache.clear();
  const afterRelease = file({ text: 'weights' });
  expect((await prepared({ cache, value: afterRelease, key: 'root-b/model', signal })).replacements.get(afterRelease)).toBe(afterRelease);
});

it('checks every index, shard and adapter against its own expected content hash', async () => {
  const cache = createVerifiedImageModelFiles(), signal = new AbortController().signal;
  const index = file({ text: 'index' }), shard = file({ text: 'shard' }), lora = file({ text: 'adapter' });
  const files = [index, shard, lora].map((file, index) => ({
    key: String(index),
    file,
    expectedSha256: createHash('sha256').update(['index', 'shard', 'adapter'][index]!).digest('hex'),
  }));
  (await cache.prepare({ files, signal })).commit();
  await expect(cache.prepare({ files: files.map((entry, index) => index === 1 ? { ...entry, file: file({ text: 'other' }) } : entry), signal })).rejects.toThrow('receipt');
});

it('bounds each read, checks the tail, and never calls File.arrayBuffer for the whole model', async () => {
  const cache = createVerifiedImageModelFiles(), signal = new AbortController().signal;
  const bytes = new Uint8Array(512 * 1024 + 1), original = new File([bytes], 'model.gguf', { lastModified: 123 });
  const whole = vi.spyOn(original, 'arrayBuffer').mockRejectedValue(new Error('Whole-file expansion forbidden'));
  const slice = vi.spyOn(original, 'slice');
  (await prepared({ cache, value: original, key: 'root/model', signal })).commit();
  expect(whole).not.toHaveBeenCalled();
  expect(slice.mock.calls.every(([start, end]) => start !== undefined && end !== undefined && end - start <= 256 * 1024)).toBe(true);
  bytes[bytes.length - 1] = 1;
  const tailChanged = new File([bytes], 'model.gguf', { lastModified: 123 });
  expect((await prepared({ cache, value: tailChanged, key: 'root/model', signal })).replacements.get(tailChanged)).toBe(tailChanged);
});

it('does not commit cancelled verification or fallback through cancellation of the old snapshot', async () => {
  const cache = createVerifiedImageModelFiles(), stop = new AbortController(), signal = stop.signal;
  const original = file({ text: 'weights' }), snapshot = await prepared({ cache, value: original, key: 'root/model', signal });
  stop.abort(); expect(() => snapshot.commit()).toThrow();
  const fresh = file({ text: 'weights' }), active = new AbortController();
  expect((await prepared({ cache, value: fresh, key: 'root/model', signal: active.signal })).replacements.get(fresh)).toBe(fresh);
  (await prepared({ cache, value: original, key: 'root/model', signal: active.signal })).commit();
  const reason = new DOMException('Cancel old snapshot verification', 'AbortError');
  vi.spyOn(original, 'slice').mockImplementation(() => {
    active.abort(reason); throw reason;
  });
  await expect(prepared({ cache, value: fresh, key: 'root/model', signal: active.signal })).rejects.toBe(reason);
});

it('rejects a short disk read before caching or starting native inference', async () => {
  const cache = createVerifiedImageModelFiles(), value = file({ text: 'weights' }), signal = new AbortController().signal;
  vi.spyOn(value, 'slice').mockReturnValue(new Blob(['short']));
  await expect(prepared({ cache, value, key: 'root/model', signal })).rejects.toThrow('changed');
});
