import { z } from "zod";
import type { ModelSupportInvestigationBatchEvidenceItem } from "@/features/transformers-js/model-support-investigation/types";
import { investigationJsonObjectSchema } from "@/features/transformers-js/model-support-investigation/logic/json-value-schema";
import { decodeEvidenceRun, encodeEvidenceRun, encodedEvidenceRunSchema } from './run-request';

interface ModelSupportInvestigationBatchEvidenceWorkerRequestPayload {
  schemaVersion: 2,
  batchId: string,
  items: readonly ModelSupportInvestigationBatchEvidenceItem[],
}

const batchEvidenceItemSchema = z.object({
  target: z.string().min(1),
  status: z.enum(["pending", "running", "passed", "failed", "skipped", "interrupted"]),
  run: investigationJsonObjectSchema.optional(),
  providerCaptureEvidence: encodedEvidenceRunSchema.shape.providerCaptureEvidence,
  providerInvestigationEvidence: encodedEvidenceRunSchema.shape.providerInvestigationEvidence,
  recovery: investigationJsonObjectSchema.optional(),
  error: z.string().optional(),
}).strict();

const batchEvidenceWorkerRequestSchema = z.object({
  schemaVersion: z.literal(2),
  batchId: z.string().min(1),
  items: z.array(batchEvidenceItemSchema).min(1),
}).strict();

export function createModelSupportInvestigationBatchEvidenceWorkerRequest({
  batchId,
  items,
}: {
  batchId: string,
  items: readonly ModelSupportInvestigationBatchEvidenceItem[],
}): Blob {
  const cloned = structuredClone({
    schemaVersion: 2 as const,
    batchId,
    items: items.map(({ replayMetadata: _replayMetadata, nativeEvidence: _nativeEvidence, run, ...item }) => ({
      ...item, ...(run === undefined ? { run: undefined } : encodeEvidenceRun({ run })),
    })),
  } satisfies ModelSupportInvestigationBatchEvidenceWorkerRequestPayload);
  return new Blob([JSON.stringify(cloned)], { type: "application/json" });
}

export async function readModelSupportInvestigationBatchEvidenceWorkerRequest({
  request,
}: {
  request: Blob,
}): Promise<ModelSupportInvestigationBatchEvidenceWorkerRequestPayload> {
  const parsed: unknown = JSON.parse(await request.text());
  const result = batchEvidenceWorkerRequestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Invalid Model Support Investigation batch Evidence Worker request", { cause: result.error });
  }
  return {
    schemaVersion: result.data.schemaVersion,
    batchId: result.data.batchId,
    items: result.data.items.map(({ run, providerCaptureEvidence, providerInvestigationEvidence, ...item }) => {
      if (run === undefined && (providerCaptureEvidence !== undefined || providerInvestigationEvidence !== undefined)) throw new Error('Provider capture Evidence requires its investigation run');
      return { ...item, run: run === undefined ? undefined : decodeEvidenceRun({ run, providerCaptureEvidence, providerInvestigationEvidence }) };
    }) as unknown as ModelSupportInvestigationBatchEvidenceItem[],
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  batchEvidenceWorkerRequestSchema,
};
