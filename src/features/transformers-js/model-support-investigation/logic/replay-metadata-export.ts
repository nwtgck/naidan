import type JSZip from 'jszip';
import { z } from 'zod';
import { replayMetadataSummarySchema, replayMetadataSha256, validateReplayMetadataContent, REPLAY_METADATA_FILE_BYTES, type InvestigationReplayMetadataSidecar } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';

export const replayMetadataSidecarsSchema = z.array(z.object({ path: z.string(), blob: z.instanceof(Blob) }).strict()).max(10);

export async function addReplayMetadataToZip({ zip, summary, sidecars }: {
  zip: JSZip,
  summary: unknown,
  sidecars: InvestigationReplayMetadataSidecar[] | undefined,
}): Promise<void> {
  if (summary === undefined) {
    if ((sidecars?.length ?? 0) > 0) throw new Error('Replay metadata sidecars require an identity summary');
    return;
  }
  const validated = replayMetadataSummarySchema.parse(summary);
  const attachments = replayMetadataSidecarsSchema.parse(sidecars ?? []);
  const paths = new Set<string>();
  for (const attachment of attachments) {
    if (paths.has(attachment.path)) throw new Error('Duplicate replay metadata sidecar');
    paths.add(attachment.path);
    const file = validated.files.find(item => item.path === attachment.path && item.status === 'collected');
    if (file === undefined || attachment.blob.size !== file.byteLength || attachment.blob.size > REPLAY_METADATA_FILE_BYTES) {
      throw new Error('Replay metadata sidecar does not match its bounded summary');
    }
    const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
    validateReplayMetadataContent({ path: attachment.path, bytes });
    if (await replayMetadataSha256({ bytes }) !== file.sha256) throw new Error('Replay metadata sidecar hash mismatch');
    zip.file(`replay-metadata/files/${attachment.path}`, bytes);
  }
  zip.file('replay-metadata/index.json', JSON.stringify({
    ...validated,
    replayScope: 'Allowlisted metadata only; not a completeness certificate for tokenizer/model runtime inputs. No model weights, past network events, or GPU execution state.',
    files: validated.files.map(file => ({ ...file, archived: paths.has(file.path) })),
  }, undefined, 2));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
