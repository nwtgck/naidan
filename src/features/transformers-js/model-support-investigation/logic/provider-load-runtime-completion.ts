import { z } from 'zod';
import { productionLoadReceiptSchema, productionLoadReceiptRevisionOption } from '@/features/transformers-js/runtime/production-load-receipt';
import type { DownloadVerificationRuntimeCompletionEvidence } from '@/features/transformers-js/download-verification/evidence/types';
import type { ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';
import { readProductionProviderLoadObservations } from './production-provider-native-evidence';

export const ordinaryProviderRuntimeCompletionSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal('ordinary-provider-load'), status: z.enum(['accepted', 'failed', 'exhausted']),
  repositoryResolvedRevision: z.string().regex(/^[a-f0-9]{40}$/u), cacheRevision: z.string().max(128).nullable(), loaderRevisionOption: z.string().max(128).nullable(),
  selectedCandidate: productionLoadReceiptSchema.shape.candidate.optional(), receipt: productionLoadReceiptSchema.optional(),
  cacheReuse: z.undefined().optional(), preparation: z.undefined().optional(), cacheAfter: z.undefined().optional(), cacheInspectionError: z.undefined().optional(),
  error: z.object({ name: z.string().max(128), message: z.string().max(2048) }).strict().optional(),
}).strict().superRefine((completion, context) => {
  switch (completion.status) {
  case 'accepted': {
    const receipt = completion.receipt;
    if (receipt === undefined || completion.error !== undefined || completion.cacheRevision !== receipt.cacheLookup.revision
      || completion.loaderRevisionOption !== (productionLoadReceiptRevisionOption({ option: receipt.loaderRevisionOption }) ?? null)
      || completion.selectedCandidate?.device !== receipt.candidate.device || completion.selectedCandidate.dtype !== receipt.candidate.dtype) {
      context.addIssue({ code: 'custom', message: 'Accepted Provider Load requires its matching successful receipt' });
    }
    break;
  }
  case 'failed': case 'exhausted':
    if (completion.receipt !== undefined || completion.cacheRevision !== null || completion.loaderRevisionOption !== null || completion.selectedCandidate !== undefined) {
      context.addIssue({ code: 'custom', message: 'Unavailable Provider receipt must not retain accepted identity' });
    }
    break;
  default: { const exhaustive: never = completion.status; throw new Error('Unknown Provider completion: ' + exhaustive); }
  }
});

/** Adopt the existing Provider Load receipt; never start a second acceptance Load. */
export function providerLoadRuntimeCompletion({ repositoryResolvedRevision, provider, summary, nativeJson }: {
  repositoryResolvedRevision: string; provider: ModelSupportInvestigationRun['productionProviderCapture'];
  summary: ModelSupportInvestigationRun['productionProviderInvestigation']; nativeJson: string | undefined;
}): DownloadVerificationRuntimeCompletionEvidence | undefined {
  if (summary === undefined) return undefined;
  const base = {
    schemaVersion: 1 as const, source: 'ordinary-provider-load' as const,
    repositoryResolvedRevision,
    cacheReuse: undefined, preparation: undefined, cacheAfter: undefined, cacheInspectionError: undefined,
  };
  const observations = provider === undefined || nativeJson === undefined ? [] : readProductionProviderLoadObservations({ json: nativeJson, provider });
  const lastEpoch = summary.cutoff.epochs.at(-1)?.workerEpoch;
  const currentWorkerWasRecorded = summary.cutoff.unrecordedWorkerCreations === 0 && summary.cutoff.incompleteReasons.length === 0;
  const observation = currentWorkerWasRecorded ? observations.findLast(item => item.owner.workerEpoch === lastEpoch) : undefined;
  const loadState = (() => {
    switch (summary.providerProgress.loadStatus) {
    case 'ready': return { ready: true, failed: false };
    case 'error': return { ready: false, failed: true };
    case 'idle': case 'loading': return { ready: false, failed: false };
    default: { const exhaustive: never = summary.providerProgress.loadStatus; throw new Error('Unknown Provider Load status: ' + exhaustive); }
    }
  })();
  switch (observation?.outcome.status) {
  case 'accepted': {
    if (!loadState.ready) break;
    const receipt = productionLoadReceiptSchema.parse(observation.outcome.receipt);
    return { ...base, status: 'accepted', cacheRevision: receipt.cacheLookup.revision,
      loaderRevisionOption: productionLoadReceiptRevisionOption({ option: receipt.loaderRevisionOption }) ?? null,
      selectedCandidate: receipt.candidate, receipt, error: undefined };
  }
  case 'loading': case 'failed': case 'cleared': case 'not-recorded': case undefined: break;
  default: { const exhaustive: never = observation!.outcome; throw new Error('Unknown Load receipt outcome: ' + exhaustive); }
  }
  return { ...base, status: loadState.failed ? 'failed' : 'exhausted',
    cacheRevision: null, loaderRevisionOption: null, selectedCandidate: undefined,
    error: { name: loadState.failed ? 'ProductionProviderLoadFailed' : 'ProductionLoadReceiptUnavailable',
      message: `Ordinary Provider Load status=${summary.providerProgress.loadStatus}; receipt=${observation?.outcome.status ?? 'not-observed'}.${currentWorkerWasRecorded ? '' : ' Current Worker ownership was not fully recorded.'} No independent acceptance Load was run.` },
  };
}

export const TEST_ONLY = {
};
