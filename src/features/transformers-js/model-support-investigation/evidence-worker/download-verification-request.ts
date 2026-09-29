import { z } from 'zod';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';
import { investigationJsonObjectSchema } from '@/features/transformers-js/model-support-investigation/logic/json-value-schema';

interface DownloadVerificationEvidenceWorkerRequestPayload {
  schemaVersion: 1;
  evidence: DownloadVerificationEvidenceInput;
}

const downloadVerificationEvidenceWorkerRequestSchema = z.object({
  schemaVersion: z.literal(1),
  evidence: investigationJsonObjectSchema,
}).strict();

export function createDownloadVerificationEvidenceWorkerRequest({ evidence }: {
  evidence: DownloadVerificationEvidenceInput;
}): Blob {
  const cloned = structuredClone({
    schemaVersion: 1 as const,
    evidence,
  } satisfies DownloadVerificationEvidenceWorkerRequestPayload);
  return new Blob([JSON.stringify(cloned)], { type: 'application/json' });
}

export async function readDownloadVerificationEvidenceWorkerRequest({ request }: {
  request: Blob;
}): Promise<DownloadVerificationEvidenceWorkerRequestPayload> {
  const parsed: unknown = JSON.parse(await request.text());
  const result = downloadVerificationEvidenceWorkerRequestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Invalid Download Verification Evidence Worker request', { cause: result.error });
  }
  return {
    schemaVersion: result.data.schemaVersion,
    evidence: result.data.evidence as unknown as DownloadVerificationEvidenceInput,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
