import { z } from 'zod';
import type { ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';
import { investigationJsonObjectSchema } from '@/features/transformers-js/model-support-investigation/logic/json-value-schema';
import { createProductionProviderCaptureEvidence, readProductionProviderCaptureEvidence, PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-evidence';
import { createProductionProviderInvestigationSummaryEvidence, readProductionProviderInvestigationSummaryEvidence } from '@/features/transformers-js/model-support-investigation/logic/production-provider-investigation-summary';

export const encodedEvidenceRunSchema = z.object({
  run: investigationJsonObjectSchema,
  providerCaptureEvidence: z.string().max(PRODUCTION_PROVIDER_CAPTURE_JSON_MAXIMUM_CHARACTERS).optional(),
  providerInvestigationEvidence: z.string().max(65536).optional(),
}).strict();

/** Keep this strict capture format out of ordinary JSON's undefined elision. */
export function encodeEvidenceRun({ run }: { run: ModelSupportInvestigationRun }) {
  for (const key of ['productionProviderCapture', 'productionProviderInvestigation']) {
    const descriptor = Object.getOwnPropertyDescriptor(run, key);
    if (descriptor !== undefined && !('value' in descriptor)) throw new Error('Invalid Provider capture in Evidence request');
  }
  const { productionProviderCapture, productionProviderInvestigation, ...body } = run;
  const providerCaptureEvidence = productionProviderCapture === undefined ? undefined : createProductionProviderCaptureEvidence({
    capture: productionProviderCapture, runId: run.runId, modelId: run.modelId,
  }).json;
  const providerInvestigationEvidence = productionProviderInvestigation === undefined ? undefined : createProductionProviderInvestigationSummaryEvidence({
    summary: productionProviderInvestigation, runId: run.runId, modelId: run.modelId,
  }).json;
  return { run: body, providerCaptureEvidence, providerInvestigationEvidence };
}

/** The ordinary Run graph retains its existing JSON validation contract. The
 * host-only Provider field is separately decoded and identity-validated here. */
export function decodeEvidenceRun({ run, providerCaptureEvidence, providerInvestigationEvidence }: z.infer<typeof encodedEvidenceRunSchema>): ModelSupportInvestigationRun {
  if (Object.hasOwn(run, 'productionProviderCapture') || Object.hasOwn(run, 'productionProviderInvestigation')) throw new Error('Raw Provider capture is not allowed in Evidence request JSON');
  if (providerCaptureEvidence === undefined && providerInvestigationEvidence === undefined) return run as unknown as ModelSupportInvestigationRun;
  const identity = z.object({ runId: z.string(), modelId: z.string() }).parse(run);
  const productionProviderCapture = providerCaptureEvidence === undefined ? undefined : readProductionProviderCaptureEvidence({ json: providerCaptureEvidence, ...identity });
  const productionProviderInvestigation = providerInvestigationEvidence === undefined ? undefined : readProductionProviderInvestigationSummaryEvidence({ json: providerInvestigationEvidence, ...identity });
  return {
    ...run,
    ...(productionProviderCapture === undefined ? {} : { productionProviderCapture }),
    ...(productionProviderInvestigation === undefined ? {} : { productionProviderInvestigation }),
  } as unknown as ModelSupportInvestigationRun;
}

export const TEST_ONLY = {
};
