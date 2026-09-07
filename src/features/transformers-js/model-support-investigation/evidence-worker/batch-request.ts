import { z } from "zod";
import type { ModelSupportInvestigationBatchEvidenceItem } from "@/features/transformers-js/model-support-investigation/types";
import { investigationJsonObjectSchema } from "@/features/transformers-js/model-support-investigation/logic/json-value-schema";

interface ModelSupportInvestigationBatchEvidenceWorkerRequestPayload {
  schemaVersion: 1,
  batchId: string,
  items: readonly ModelSupportInvestigationBatchEvidenceItem[],
}

const batchEvidenceItemSchema = z.object({
  target: z.string().min(1),
  status: z.enum(["pending", "running", "passed", "failed", "interrupted"]),
  run: investigationJsonObjectSchema.optional(),
  recovery: investigationJsonObjectSchema.optional(),
  error: z.string().optional(),
}).strict();

const batchEvidenceWorkerRequestSchema = z.object({
  schemaVersion: z.literal(1),
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
    schemaVersion: 1 as const,
    batchId,
    items,
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
    items: result.data.items as unknown as ModelSupportInvestigationBatchEvidenceItem[],
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  batchEvidenceWorkerRequestSchema,
};
