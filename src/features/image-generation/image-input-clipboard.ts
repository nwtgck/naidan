/** Clipboard events do not request permission. Prefer files to avoid importing
 * the same image twice when the browser also exposes it as an item. */
export function pastedImageFiles({ data }: { data: DataTransfer | undefined }): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files.filter(file => file.type.startsWith('image/'));
  return Array.from(data.items ?? []).flatMap(item => {
    if (!item.type.startsWith('image/')) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

/** Called only following a user's click. One clipboard item may expose several
 * representations of the SAME image; choose one, not all of them. */
export async function readClipboardImageFiles({ clipboard }: { clipboard: Pick<Clipboard, 'read'> }): Promise<File[]> {
  const items = await clipboard.read();
  const files: File[] = [];
  for (const item of items) {
    const type = ['image/png', 'image/jpeg', 'image/webp'].find(type => item.types.includes(type));
    if (!type) continue;
    const blob = await item.getType(type);
    const extension = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length);
    files.push(new File([blob], `clipboard-${files.length + 1}.${extension}`, { type }));
  }
  return files;
}
export const TEST_ONLY = {
};
