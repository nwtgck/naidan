import { z } from "zod";
import type {
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import { investigationJsonObjectSchema } from "@/features/transformers-js/model-support-investigation/logic/json-value-schema";
import { decodeEvidenceRun, encodeEvidenceRun, encodedEvidenceRunSchema } from './run-request';

interface ModelSupportInvestigationEvidenceWorkerRequestPayload {
  schemaVersion: 2,
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery | undefined,
}

const evidenceWorkerRequestSchema = z.object({
  schemaVersion: z.literal(2),
  ...encodedEvidenceRunSchema.shape,
  recovery: investigationJsonObjectSchema.optional(),
}).strict();

export function createModelSupportInvestigationEvidenceWorkerRequest({
  run,
  recovery,
}: {
  run: ModelSupportInvestigationRun,
  recovery: ModelSupportInvestigationRecovery | undefined,
}): Blob {
  // Validate the complete graph before crossing the Worker boundary. Accidental functions or
  // proxies therefore fail locally instead of surfacing as a postMessage DataCloneError.
  const cloned = structuredClone({
    schemaVersion: 2 as const,
    ...encodeEvidenceRun({ run }),
    recovery,
  } satisfies ModelSupportInvestigationEvidenceWorkerRequestPayload);
  return new Blob([JSON.stringify(cloned)], { type: "application/json" });
}

export async function readModelSupportInvestigationEvidenceWorkerRequest({
  request,
}: {
  request: Blob,
}): Promise<ModelSupportInvestigationEvidenceWorkerRequestPayload> {
  const parsed: unknown = JSON.parse(await request.text());
  const result = evidenceWorkerRequestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Invalid Model Support Investigation Evidence Worker request", { cause: result.error });
  }
  return {
    schemaVersion: result.data.schemaVersion,
    run: decodeEvidenceRun({ run: result.data.run, providerCaptureEvidence: result.data.providerCaptureEvidence, providerInvestigationEvidence: result.data.providerInvestigationEvidence }),
    recovery: result.data.recovery as unknown as ModelSupportInvestigationRecovery | undefined,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
