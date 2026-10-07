import { z } from 'zod';
import { modelFileMarker, optionalModelFile, readModelMarkerJson, writeModelMarkerJson } from '@/logic/model-file-publication';
import { repositoryFileSchema, repositorySchema, revisionSchema, type DownloadSelection } from './types';
const markerSchema = z.object({ version: z.literal(1), kind: z.literal('naidan-llama-download'), repository: repositorySchema, revision: revisionSchema, file: repositoryFileSchema }).strict();
export async function hostDownloadMarker({ folder, selection, index, action }: {
  folder: FileSystemDirectoryHandle, selection: DownloadSelection, index: number, action: 'create' | 'remove' | 'check',
}): Promise<void> {
  const file = selection.files[index]; if (!file) throw new Error('Invalid host download file');
  const parts = file.path.split('/'); const name = parts.pop()!;
  for (const part of parts) {
    try {
      folder = await folder.getDirectoryHandle(part, { create: action === 'create' });
    } catch (error) {
      if (action === 'check' && error instanceof DOMException && error.name === 'NotFoundError') return;
      throw error;
    }
  }
  const markerName = modelFileMarker({ name, state: 'pending' });
  const expected = markerSchema.parse({ version: 1, kind: 'naidan-llama-download', repository: selection.repository, revision: selection.revision, file });
  const previous = await optionalModelFile({ directory: folder, name: markerName });
  if (previous && JSON.stringify(markerSchema.parse(await readModelMarkerJson({ handle: previous }))) !== JSON.stringify(expected)) throw new Error('Another operation owns this pending model file');
  switch (action) {
  case 'check': return;
  case 'create':
    if (!previous) await writeModelMarkerJson({ directory: folder, name: markerName, value: expected });
    return;
  case 'remove':
    if (!previous) throw new Error('Pending model marker changed before publication');
    await folder.removeEntry(markerName); return;
  default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
  }
}
export function hostDownloadMarkerPath({ path }: { path: string }): string {
  const parts = path.split('/'); const name = parts.pop()!; return [...parts, modelFileMarker({ name, state: 'pending' })].join('/');
}
export const TEST_ONLY = {
};
