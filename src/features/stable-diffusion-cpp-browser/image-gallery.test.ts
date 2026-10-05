import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageGallery } from './image-gallery';
let sequence = 0;
beforeEach(() => {
  sequence = 0;
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => `blob:gallery-${++sequence}`);
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => vi.unstubAllGlobals());
const blob = () => new Blob(['1234'], { type: 'image/png' });
it('retains more than four explicit results, trims oldest, and revokes once per owner', () => {
  const gallery = createImageGallery<{ name: string }>({ initialLimit: 6, maxBytes: 10000 });
  for (let n = 1; n <= 7; n++) gallery.add({ blob: blob(), width: 2, height: 2, metadata: { name: String(n) } });
  expect(gallery.entries().map(item => item.name)).toEqual(['7', '6', '5', '4', '3', '2']);
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:gallery-1');
  gallery.setLimit({ value: 2 });
  expect(gallery.entries().map(item => item.name)).toEqual(['7', '6']);
  gallery.remove({ id: 6 }); gallery.remove({ id: 6 });
  gallery.clear(); gallery.clear();
  expect(gallery.bytes()).toBe(0);
  expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(call => call[0]).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `blob:gallery-${i + 1}`).sort());
});
it('bounds bytes independently of the count and rejects oversized images before URL allocation', () => {
  const gallery = createImageGallery({ initialLimit: 100, maxBytes: 44 });
  for (let n = 0; n < 4; n++) gallery.add({ blob: blob(), width: 2, height: 2, metadata: {} });
  expect(gallery.entries()).toHaveLength(2); expect(gallery.bytes()).toBe(40);
  expect(() => gallery.add({ blob: blob(), width: 8, height: 8, metadata: {} })).toThrow('budget');
  expect(URL.createObjectURL).toHaveBeenCalledTimes(4);
  gallery.setLimit({ value: 0 }); expect(gallery.entries()).toHaveLength(2); gallery.clear();
});
it('live and retained snapshots own distinct URLs even when sharing a Blob', () => {
  const live = createImageGallery({ initialLimit: 1, maxBytes: 1000 });
  const history = createImageGallery({ initialLimit: 16, maxBytes: 1000 });
  const png = blob();
  const frame = { blob: png, width: 2, height: 2, metadata: {} };
  const oldLive = live.add(frame), kept = history.add(frame);
  live.add(frame);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldLive.url);
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(kept.url);
  history.clear(); live.clear();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
});
