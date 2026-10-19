import { z } from 'zod';
import { modelSourceSelectionSchema } from '@/01-models/llama-cpp-browser-model-launch';
import type { DownloadDestination } from '@/01-models/download';
import { modelFileMarker, optionalModelFile, readModelMarkerJson, writeModelMarkerJson } from '@/logic/model-file-publication';
import { pendingDownloadSchema, readPendingDownload } from './pending';
import type { HuggingFaceFile } from './source';
import { withDownloadRepository } from './storage';

const legacyName = '.llama-cpp-import-pending';
const legacySchema = z.object({
  version: z.literal(1),
  selection: modelSourceSelectionSchema,
  bytes: z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  complete: z.array(z.boolean()),
  reused: z.array(z.boolean()).optional(),
}).strict().refine(value => value.bytes.length === value.selection.files.length && value.complete.length === value.bytes.length && (value.reused === undefined || value.reused.length === value.bytes.length) && value.bytes.every((bytes, index) => bytes <= value.selection.files[index]!.size && (!value.complete[index] || bytes === value.selection.files[index]!.size)));

/** No eager disk migration. An explicit request with the complete, matching old
 * selection may migrate its own journal. Local imports and unknown data stay put.
 * Every file is protected before the repository-wide protection is removed.
 */
export async function migrateLegacyDownloads({ files, destination, expectedRoot, signal }: {
  files: readonly HuggingFaceFile[], destination: DownloadDestination, expectedRoot: FileSystemDirectoryHandle | undefined, signal: AbortSignal,
}): Promise<void> {
  for (const repository of new Set(files.map(file => file.repository))) {
    await withDownloadRepository({
      repository,
      destination,
      expectedRoot,
      signal,
      run: async ({ folder }) => {
        const handle = await optionalModelFile({ directory: folder, name: legacyName });
        if (!handle) {
          return;
        }
        let original: unknown;
        try {
          original = await readModelMarkerJson({ handle });
        } catch {
          throw new Error('Repository has an unfinished operation; its existing data was not modified');
        }
        const parsed = legacySchema.safeParse(original);
        if (!parsed.success || parsed.data.selection.repository !== repository) {
          throw new Error('Repository has an unfinished operation; its existing data was not modified');
        }
        const journal = parsed.data;
        const plans = [];
        for (const [index, previous] of journal.selection.files.entries()) {
          const identity = files.find(file => file.repository === repository && file.revision === journal.selection.revision && file.path === previous.path && file.size === previous.size);
          if (!identity) {
            throw new Error('Resume the complete unfinished selection before another repository download');
          }
          if (journal.reused?.[index]) {
            continue;
          }
          const parts = identity.path.split('/');
          const name = parts.pop()!;
          let directory = folder;
          for (const part of parts) {
            directory = await directory.getDirectoryHandle(part, { create: true });
          }
          const payload = await optionalModelFile({ directory, name });
          if ((!payload && journal.bytes[index] !== 0) || (payload && (await payload.getFile()).size < journal.bytes[index]!)) {
            throw new Error('Unfinished file is shorter than its journal; existing data was preserved');
          }
          const markerName = modelFileMarker({ name, state: 'pending' });
          const marker = await optionalModelFile({ directory, name: markerName });
          const markerValue = marker ? await readModelMarkerJson({ handle: marker }) : undefined;
          const next = pendingDownloadSchema.parse({ version: 2, kind: 'naidan-file-download', source: identity, bytes: journal.bytes[index], state: 'partial' });
          if (marker) {
            const hostMarker = { version: 1, kind: 'naidan-llama-download', repository, revision: journal.selection.revision, file: previous };
            if (JSON.stringify(markerValue) !== JSON.stringify(hostMarker)) {
            // A previous interrupted migration may already have protected this file.
              const migrated = readPendingDownload({ value: markerValue });
              if (JSON.stringify(migrated) !== JSON.stringify(next)) {
                throw new Error('Another operation owns the unfinished file; existing data was preserved');
              }
            }
          }
          plans.push({ directory, name: markerName, marker, markerValue, next });
        }
        for (const plan of plans) {
          signal.throwIfAborted();
          const current = await optionalModelFile({ directory: plan.directory, name: plan.name });
          if (plan.marker ? !current || !await current.isSameEntry(plan.marker) || JSON.stringify(await readModelMarkerJson({ handle: current })) !== JSON.stringify(plan.markerValue) : current !== undefined) {
            throw new Error('Pending marker changed during migration');
          }
          await writeModelMarkerJson({ directory: plan.directory, name: plan.name, value: plan.next });
        }
        signal.throwIfAborted();
        for (const plan of plans) {
          const marker = await optionalModelFile({ directory: plan.directory, name: plan.name });
          if (!marker || JSON.stringify(await readModelMarkerJson({ handle: marker })) !== JSON.stringify(plan.next)) {
            throw new Error('Migrated pending marker changed; repository journal was preserved');
          }
        }
        const current = await optionalModelFile({ directory: folder, name: legacyName });
        if (!current || !await current.isSameEntry(handle) || JSON.stringify(await readModelMarkerJson({ handle: current })) !== JSON.stringify(original)) {
          throw new Error('Repository journal changed during migration');
        }
        await folder.removeEntry(legacyName);
      },
    });
  }
}

export const TEST_ONLY = {
};
