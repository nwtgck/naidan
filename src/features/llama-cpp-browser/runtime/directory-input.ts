import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

export function directoryFromFiles({ files }: { files: File[] }): ModelDirectoryInput {
  const first = files[0]?.webkitRelativePath.split('/')[0];
  if (!first) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  return { name: first, files: files.map(file => {
    const prefix = `${first}/`;
    if (!file.webkitRelativePath.startsWith(prefix)) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    return { path: file.webkitRelativePath.slice(prefix.length), file };
  }) };
}
export async function droppedModels({ transfer }: { transfer: DataTransfer }): Promise<{ directories: ModelDirectoryInput[], files: File[] }> {
  // Capture entries synchronously: the drag data store is protected after dispatch.
  const entries = Array.from(transfer.items ?? []).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.());
  if (entries.length === 0 || entries.every(entry => !entry)) {
    const files = Array.from(transfer.files);
    const directories = new Map<string, File[]>(); const direct: File[] = [];
    for (const file of files) {
      if (file.webkitRelativePath) {
        const root = file.webkitRelativePath.split('/')[0]!;
        const group = directories.get(root) ?? []; group.push(file); directories.set(root, group);
      } else {
        // Browsers without directory entries may expose a directory as an opaque
        // File. Never reinterpret it as a model and lose its root name.
        if (!/\.gguf$/i.test(file.name)) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
        direct.push(file);
      }
    }
    return { directories: Array.from(directories.values(), files => directoryFromFiles({ files })), files: direct };
  }
  if (entries.some(entry => !entry)) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  const directories: ModelDirectoryInput[] = []; const files: File[] = [];
  async function readFile({ entry }: { entry: FileSystemEntry }): Promise<File> {
    if (!entry.isFile) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    return new Promise((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
  }
  async function walk({ entry, prefix }: { entry: FileSystemDirectoryEntry, prefix: string }): Promise<ModelDirectoryInput['files']> {
    const result: ModelDirectoryInput['files'] = []; const reader = entry.createReader();
    while (true) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) {
        if (child.isDirectory) result.push(...await walk({ entry: child as FileSystemDirectoryEntry, prefix: `${prefix}${child.name}/` }));
        else result.push({ path: `${prefix}${child.name}`, file: await readFile({ entry: child }) });
      }
    }
    return result;
  }
  for (const entry of entries) {
    if (!entry) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    if (entry.isDirectory) directories.push({ name: entry.name, files: await walk({ entry: entry as FileSystemDirectoryEntry, prefix: '' }) });
    else files.push(await readFile({ entry }));
  }
  return { directories, files };
}
export const TEST_ONLY = {
};
