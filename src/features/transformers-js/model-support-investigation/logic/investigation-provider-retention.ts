import { z } from 'zod';
import type { ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';
import { createProductionProviderCaptureEvidence } from './production-provider-capture-evidence';
import { createProductionProviderInvestigationSummaryEvidence } from './production-provider-investigation-summary';
import { measureProductionProviderNativeEvidenceSidecar, type ProductionProviderNativeEvidenceSidecar } from './production-provider-native-evidence';

// These are logical retained/reserved recording budgets, not bounds on ZIP
// size, total process heap, Worker heaps, or temporary platform copies.
export const PRODUCTION_PROVIDER_NATIVE_BATCH_BINARY_BYTES = 256 * 1024 * 1024;
export const PRODUCTION_PROVIDER_NATIVE_BATCH_JSON_CHARACTERS = 64 * 1024 * 1024;
export const PRODUCTION_PROVIDER_BATCH_JSON_CHARACTERS = 64 * 1024 * 1024;

const usageSchema = z.object({
  nativeBinaryBytes: z.number().int().nonnegative().safe(),
  nativeJsonCharacters: z.number().int().nonnegative().safe(),
  providerJsonCharacters: z.number().int().nonnegative().safe(),
}).strict();
export type InvestigationProviderRetentionUsage = Readonly<z.infer<typeof usageSchema>>;
const keys = usageSchema.keyof().options;

export const investigationProviderRetentionLimits: InvestigationProviderRetentionUsage = Object.freeze({
  nativeBinaryBytes: PRODUCTION_PROVIDER_NATIVE_BATCH_BINARY_BYTES,
  nativeJsonCharacters: PRODUCTION_PROVIDER_NATIVE_BATCH_JSON_CHARACTERS,
  providerJsonCharacters: PRODUCTION_PROVIDER_BATCH_JSON_CHARACTERS,
});

export function emptyInvestigationProviderRetentionUsage(): InvestigationProviderRetentionUsage {
  return Object.freeze({ nativeBinaryBytes: 0, nativeJsonCharacters: 0, providerJsonCharacters: 0 });
}

/** Measure one batch's owned records. Native payloads have already passed the
 * asynchronous sidecar verifier before adoption; this step reads no Blob body. */
export function measureInvestigationProviderRetention({ runs, nativeEvidence }: {
  runs: ReadonlyMap<string, ModelSupportInvestigationRun>;
  nativeEvidence: ReadonlyMap<string, ProductionProviderNativeEvidenceSidecar>;
}): InvestigationProviderRetentionUsage {
  let providerJsonCharacters = 0;
  let nativeBinaryBytes = 0;
  let nativeJsonCharacters = 0;
  for (const run of runs.values()) {
    if (run.productionProviderCapture !== undefined) {
      providerJsonCharacters += createProductionProviderCaptureEvidence({ capture: run.productionProviderCapture, runId: run.runId, modelId: run.modelId }).json.length;
    }
    if (run.productionProviderInvestigation !== undefined) {
      providerJsonCharacters += createProductionProviderInvestigationSummaryEvidence({ summary: run.productionProviderInvestigation, runId: run.runId, modelId: run.modelId }).json.length;
    }
  }
  for (const [target, evidence] of nativeEvidence) {
    if (runs.get(target)?.productionProviderCapture === undefined) throw new Error('Native recording requires its Provider anchor');
    const measured = measureProductionProviderNativeEvidenceSidecar({ evidence });
    nativeBinaryBytes += measured.binaryBytes;
    nativeJsonCharacters += measured.jsonCharacters;
  }
  return usageSchema.parse({ nativeBinaryBytes, nativeJsonCharacters, providerJsonCharacters });
}

/** Shared because reservation, retained evidence and released ownership belong
 * to the same batch budget. A deadline never calls release: the caller must
 * first confirm cleanup and wait for the actual sealing owner to settle. */
export function createInvestigationProviderRetentionBudget({ limits: rawLimits, retained: rawRetained }: {
  limits: InvestigationProviderRetentionUsage;
  retained: InvestigationProviderRetentionUsage;
}) {
  const limits = usageSchema.parse(rawLimits);
  const retained = usageSchema.parse(rawRetained);
  const reserved = { ...emptyInvestigationProviderRetentionUsage() };
  if (keys.some(key => retained[key] > limits[key])) throw new Error('Investigation recording capacity is exhausted');
  return {
    snapshot() {
      return Object.freeze({ retained: Object.freeze({ ...retained }), reserved: Object.freeze({ ...reserved }) });
    },
    reserve({ maximum: rawMaximum }: { maximum: InvestigationProviderRetentionUsage }) {
      const maximum = usageSchema.parse(rawMaximum);
      if (keys.some(key => maximum[key] > limits[key] - retained[key] - reserved[key])) {
        throw new Error('Investigation recording capacity is exhausted');
      }
      for (const key of keys) reserved[key] += maximum[key];
      let state: 'reserved' | 'released' = 'reserved';
      return {
        release({ retained: rawActual }: { retained: InvestigationProviderRetentionUsage }): void {
          switch (state) {
          case 'released': throw new Error('Investigation reservation was already released');
          case 'reserved': break;
          default: { const exhaustive: never = state; throw new Error('Unhandled reservation state: ' + exhaustive); }
          }
          const actual = usageSchema.parse(rawActual);
          if (keys.some(key => actual[key] > maximum[key])) throw new Error('Investigation recording exceeded its reservation');
          for (const key of keys) {
            reserved[key] -= maximum[key];
            retained[key] += actual[key];
          }
          state = 'released';
        },
      };
    },
  };
}

export const TEST_ONLY = {
};
