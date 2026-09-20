import { isOpfsStagingFileName } from './opfs-staging-file';

/** Delete only identifiable TJS artifacts from the shared model directory.
 * Completion markers establish ownership of metadata; unfinished ONNX files
 * and writer staging files are also ours. Unmarked generic files stay intact.
 */
export async function removeTransformersModelFiles({ parent, name }: {
  parent: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  const folder = await parent.getDirectoryHandle(name, { create: false });
  const files = new Set<string>();
  const directories: string[] = [];
  for await (const [entryName, handle] of folder.entries()) {
    switch (handle.kind) {
    case 'file': files.add(entryName); break;
    case 'directory': directories.push(entryName); break;
    default: { const exhaustive: never = handle; throw new Error(String(exhaustive)); }
    }
  }
  for (const directory of directories) await removeTransformersModelFiles({ parent: folder, name: directory });
  for (const file of files) {
    const marker = /^\.(.+)\.complete$/.exec(file);
    const target = marker?.[1] ?? file;
    // A GGUF file belongs to another engine even if an external import left a marker.
    if (/\.gguf$/i.test(target)) continue;
    if (marker || files.has(`.${file}.complete`) || /\.onnx(?:_data(?:_\d+)?)?$/i.test(file) || isOpfsStagingFileName({ fileName: file })) {
      await folder.removeEntry(file);
    }
  }
  try {
    // Never recursively remove shared folders: preserve unrelated and newly added files.
    await parent.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError'].includes(error.name))) throw error;
  }
}

export const TEST_ONLY = {
};
