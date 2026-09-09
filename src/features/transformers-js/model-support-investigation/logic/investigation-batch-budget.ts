import { resolveInvestigationExecutionPlan, type ModelSupportInvestigationConfiguration } from './investigation-config';
import { REPLAY_METADATA_BATCH_BYTES, REPLAY_METADATA_TARGET_BYTES } from './collect-replay-metadata';
import type { ModelSupportInvestigationRecovery, ModelSupportInvestigationRun } from '@/features/transformers-js/model-support-investigation/types';

// Reserve another minute for the existing bounded Evidence exporter. Full model
// investigation keeps its explicit runtime budgets; this limit is metadata-only.
export const DOWNLOAD_INVESTIGATION_COLLECTION_BUDGET_MS = 240_000;
export const DOWNLOAD_INVESTIGATION_METADATA_BUDGET_BYTES = REPLAY_METADATA_BATCH_BYTES;
export const DOWNLOAD_INVESTIGATION_TARGET_METADATA_BYTES = REPLAY_METADATA_TARGET_BYTES;

export function isDownloadOnlyInvestigation({ configuration }: {
  configuration: ModelSupportInvestigationConfiguration;
}): boolean {
  const plan = resolveInvestigationExecutionPlan({ scope: configuration.scope });
  return plan.repositoryDownload && !plan.modelLoad;
}

export function targetInvestigationBudgetMs({ deadlineMs, nowMs, remainingTargets }: {
  deadlineMs: number;
  nowMs: number;
  remainingTargets: number;
}): number {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)
    || !Number.isSafeInteger(remainingTargets) || remainingTargets < 1) {
    throw new Error('Invalid investigation batch budget');
  }
  // Fair slices prevent a stalled first model from consuming every later model's
  // opportunity to collect evidence. Faster targets leave their time for others.
  return Math.max(0, Math.floor((deadlineMs - nowMs) / remainingTargets));
}

export function settledReplayMetadataBytes({ summary, freshMetadata, recovery }: {
  summary: ModelSupportInvestigationRun['replayMetadata'];
  freshMetadata: ModelSupportInvestigationRun['freshMetadata'];
  recovery: ModelSupportInvestigationRecovery | undefined;
}): number | undefined {
  if (summary === undefined || recovery === undefined) return undefined;
  // A file-level timeout can finish the collector while its last read is still
  // in flight. Its late chunk is deliberately discarded, not counted as zero.
  if (summary.files.some(file => file.status === 'timeout')) return undefined;
  let receivedBytes = summary.receivedBytes;
  if (freshMetadata !== undefined) {
    // Raw sidecars omit size probes, discarded responses and failed acquisition
    // bytes. Never refund those transfers just because less JSON was retained.
    // In-flight or interrupted full-body reads cannot certify a final count.
    switch (freshMetadata.status) {
    case 'prepared':
    case 'failed': break;
    case 'running':
    case 'timeout':
    case 'interrupted': return undefined;
    case 'not-run': break;
    default: {
      const _ex: never = freshMetadata.status;
      throw new Error(`Unhandled fresh metadata status: ${_ex}`);
    }
    }
    if (freshMetadata.requests.some(request => {
      switch (request.status) {
      case 'complete': return false;
      // The upstream metadata prepass normally cancels unused size-probe
      // bodies. The transport emits cancelled only after source acknowledgement.
      // Count bytes observed by fetch, not unobservable browser/OS prefetch.
      case 'cancelled': return request.request !== 'size-probe';
      case 'requesting':
      case 'reading':
      case 'cancelling':
      case 'failed': return true;
      default: {
        const _ex: never = request.status;
        throw new Error(`Unhandled fresh metadata request status: ${_ex}`);
      }
      }
    })) return undefined;
    // A memory replay reads the same downloaded bytes a second time. Its
    // counter and the HTTP counter overlap; summing them would double-charge.
    receivedBytes = Math.max(receivedBytes, freshMetadata.receivedBytes);
  }
  // The collector publishes a terminal summary only after its bounded reads
  // settle. A later Full runtime timeout cannot make that accounting unknown
  // again. Lost checkpoints / collecting summaries still keep the reservation.
  switch (summary.status) {
  case 'complete':
  case 'partial': return receivedBytes;
  case 'collecting': return undefined;
  default: {
    const _ex: never = summary.status;
    throw new Error(`Unhandled metadata collection status: ${_ex}`);
  }
  }
}

export class InvestigationTargetBudgetError extends Error {
  constructor({ timeoutMs }: { timeoutMs: number }) {
    super(`Download investigation target exceeded its ${timeoutMs} ms batch time allocation; partial evidence was retained`);
    this.name = 'InvestigationTargetBudgetError';
  }
}

export async function withInvestigationTargetBudget<T>({ start, timeoutMs, stop }: {
  start: () => Promise<T>;
  timeoutMs: number | undefined;
  stop: () => void;
}): Promise<T> {
  if (timeoutMs === undefined) return await start();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid investigation target timeout');
  if (timeoutMs === 0) {
    try {
      stop();
    } catch { /* Preserve the budget outcome if cleanup fails. */ }
    throw new InvestigationTargetBudgetError({ timeoutMs });
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const failure = new InvestigationTargetBudgetError({ timeoutMs });
      try {
        // stop must synchronously revoke callbacks and request termination. Do
        // not await an unresponsive remote's cleanup before returning evidence.
        stop();
      } catch { /* Preserve the budget outcome if cleanup fails. */ }
      reject(failure);
    }, timeoutMs);
    void Promise.resolve().then(start).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
