import { z } from 'zod';

/** Per-file publication shared by image downloads and the llama.cpp reader.
 * A pending marker always wins, even when a crash left a complete receipt too.
 * Receipts record a verified File snapshot; they are not signatures/authorship.
 */
export function modelFileMarker({ name, state }: { name: string, state: 'complete' | 'pending' }): string {
  if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..') throw new Error('Invalid model filename');
  return `.${name}.${state}`;
}
export async function optionalModelFile({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<FileSystemFileHandle | undefined> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}
export async function modelFileIsPending({ directory, name }: { directory: FileSystemDirectoryHandle, name: string }): Promise<boolean> {
  return (await optionalModelFile({ directory, name: modelFileMarker({ name, state: 'pending' }) })) !== undefined;
}
const safeSize = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const modelFileSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('hugging-face'), repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export const modelFileReceiptSchema = z.object({ version: z.literal(1), kind: z.literal('naidan-model-file'), size: safeSize,
  lastModified: safeSize, source: modelFileSourceSchema }).strict();
export type ModelFileReceipt = z.infer<typeof modelFileReceiptSchema>;
export async function readModelMarkerJson({ handle }: { handle: FileSystemFileHandle }): Promise<unknown> {
  const file = await handle.getFile();
  if (file.size > 64 * 1024) throw new Error('Model file marker exceeds its size limit');
  return JSON.parse(await file.text());
}
export async function writeModelMarkerJson({ directory, name, value }: { directory: FileSystemDirectoryHandle, name: string, value: unknown }): Promise<FileSystemFileHandle> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(JSON.stringify(value)); await writer.close(); return handle;
  } catch (error) {
    await writer.abort().catch(() => undefined); throw error;
  }
}
export async function readModelFileReceipt({ directory, name, file }: { directory: FileSystemDirectoryHandle, name: string, file: File }): Promise<ModelFileReceipt | undefined> {
  if (await modelFileIsPending({ directory, name })) return undefined;
  const handle = await optionalModelFile({ directory, name: modelFileMarker({ name, state: 'complete' }) });
  if (!handle) return undefined;
  let value: unknown;
  try {
    value = await readModelMarkerJson({ handle });
  } catch (error) {
    // Only malformed content is absence of a receipt. Permission/I/O errors
    // remain observable and must never authorize an overwrite or a download.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const parsed = modelFileReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.size !== file.size || parsed.data.lastModified !== file.lastModified) return undefined;
  return parsed.data;
}
export async function publishModelFile({ directory, name, handle, file, source }: {
  directory: FileSystemDirectoryHandle, name: string, handle: FileSystemFileHandle, file: File, source: ModelFileReceipt['source'],
}): Promise<void> {
  const current = await directory.getFileHandle(name); const now = await current.getFile();
  if (!await current.isSameEntry(handle) || now.size !== file.size || now.lastModified !== file.lastModified) throw new Error('Model changed before publication');
  await writeModelMarkerJson({ directory, name: modelFileMarker({ name, state: 'complete' }), value: modelFileReceiptSchema.parse({ version: 1, kind: 'naidan-model-file', size: file.size, lastModified: file.lastModified, source }) });
}
export const TEST_ONLY = {
};
