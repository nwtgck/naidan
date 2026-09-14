import { z } from 'zod';
import { downloadTimingSnapshotSchema, type DownloadTimingSnapshot } from '@/features/transformers-js/download-timing';
import { createEvidenceArchive, openEvidenceArchive, setEvidenceFile, type EvidenceArchiveReader } from './evidence-archive';

export const ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH = 'download-lane/ordinary-download-timing.json';
export const ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES = 1024 * 1024;

const associationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retained-export'), exportId: z.string().min(1).max(128), investigation: z.literal('not-run') }).strict(),
  z.object({ kind: z.literal('investigation-run'), runId: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('investigation-batch'), batchId: z.string().min(1).max(128) }).strict(),
]);

export const ordinaryDownloadTimingEvidenceSchema = z.object({
  format: z.literal('ordinary-download-timing-evidence-v1'),
  association: associationSchema,
  snapshot: downloadTimingSnapshotSchema,
}).strict();

export type OrdinaryDownloadTimingAssociation = z.infer<typeof associationSchema>;

/** Packaging associates an earlier observation with an export, never with a new Load. */
export function createOrdinaryDownloadTimingEvidenceFile({ snapshot, association }: {
  snapshot: DownloadTimingSnapshot;
  association: OrdinaryDownloadTimingAssociation;
}): Blob {
  const document = ordinaryDownloadTimingEvidenceSchema.parse({
    format: 'ordinary-download-timing-evidence-v1', association, snapshot,
  });
  const file = new Blob([JSON.stringify(document)], { type: 'application/json' });
  if (file.size > ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES) throw new Error('Retained Download timing exceeds its export byte budget');
  return file;
}

export async function readOrdinaryDownloadTimingEvidenceFile({ file }: { file: Blob }) {
  // Worker request Blobs are checked before decoding JSON. Archive callers
  // additionally refuse oversized entries before opening their ZIP stream.
  if (file.size > ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES) throw new Error('Retained Download timing exceeds its export byte budget');
  return ordinaryDownloadTimingEvidenceSchema.parse(JSON.parse(await file.text()) as unknown);
}

export async function verifyOrdinaryDownloadTimingEvidence({ archive, association }: {
  archive: EvidenceArchiveReader;
  association: OrdinaryDownloadTimingAssociation;
}): Promise<void> {
  const file = await archive.read({ path: ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH, maximumBytes: ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES });
  if (file === undefined) return;
  const document = await readOrdinaryDownloadTimingEvidenceFile({ file });
  if (JSON.stringify(document.association) !== JSON.stringify(associationSchema.parse(association))) {
    throw new Error('Retained Download timing export association mismatch');
  }
}

export async function createRetainedDownloadTimingEvidence({ snapshot, exportId }: {
  snapshot: DownloadTimingSnapshot;
  exportId: string;
}): Promise<{ blob: Blob; fileName: string }> {
  const association = associationSchema.parse({ kind: 'retained-export', exportId, investigation: 'not-run' });
  const file = createOrdinaryDownloadTimingEvidenceFile({ snapshot, association });
  if (snapshot.records.length === 0) throw new Error('No retained Download timing is available in this service session');
  const files = new Map<string, Blob>();
  setEvidenceFile({ files, path: ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH, content: file });
  const blob = await createEvidenceArchive({ files });
  const archive = await openEvidenceArchive({ blob });
  try {
    if (archive.reader.paths.length !== 1 || archive.reader.paths[0] !== ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH) {
      throw new Error('Unexpected retained Download timing archive contents');
    }
    await verifyOrdinaryDownloadTimingEvidence({ archive: archive.reader, association });
    const packaged = await archive.reader.read({ path: ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH, maximumBytes: ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES });
    if (packaged === undefined || await packaged.text() !== await file.text()) throw new Error('Retained Download timing archive changed its snapshot');
  } finally {
    await archive.close();
  }
  return { blob, fileName: `download-timing-${exportId.replace(/[^a-zA-Z0-9_-]/gu, '-')}.zip` };
}

export const TEST_ONLY = {
};
