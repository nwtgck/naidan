export type GalleryEntry<T> = T & { id: number, url: string };

/** Each slot owns its own URL. Shared Blob bytes may back live/history URLs,
 * but revoking one owner must never break another owner's image. */
export function createImageGallery<T extends object>({ maxBytes, initialLimit }: { maxBytes: number, initialLimit: number }) {
  let next = 0, used = 0, limit = initialLimit;
  let items: { entry: GalleryEntry<T>, bytes: number }[] = [];
  const revoke = ({ item }: { item: { entry: GalleryEntry<T>, bytes: number } }) => {
    URL.revokeObjectURL(item.entry.url); used -= item.bytes;
  };
  function trim(): void {
    while (items.length > limit || used > maxBytes) {
      const item = items.pop(); if (!item) break; revoke({ item });
    }
  }
  return {
    add({ blob, width, height, metadata }: { blob: Blob, width: number, height: number, metadata: T }): GalleryEntry<T> {
      // Include one decoded RGBA surface in accounting; browser internals may
      // use additional storage, so this is an ownership budget, not a heap cap.
      const bytes = blob.size + width * height * 4;
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxBytes) throw new Error('Image exceeds gallery memory budget');
      const entry = { ...metadata, id: ++next, url: URL.createObjectURL(blob) };
      items.unshift({ entry, bytes }); used += bytes; trim(); return entry;
    },
    entries(): GalleryEntry<T>[] {
      return items.map(item => item.entry);
    },
    setLimit({ value }: { value: number }): void {
      if (!Number.isInteger(value) || value < 1 || value > 100) return;
      limit = value; trim();
    },
    remove({ id }: { id: number }): void {
      const item = items.find(item => item.entry.id === id);
      if (item) {
        items = items.filter(value => value !== item); revoke({ item });
      }
    },
    clear(): void {
      for (const item of items) revoke({ item }); items = [];
    },
    bytes(): number {
      return used;
    },
  };
}
export const TEST_ONLY = {
};
