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

export function settledReplayMetadataBytes({ summary, recovery }: {
  summary: ModelSupportInvestigationRun['replayMetadata'];
  recovery: ModelSupportInvestigationRecovery | undefined;
}): number | undefined {
  if (summary === undefined || recovery === undefined) return undefined;
  // A file-level timeout can finish the collector while its last read is still
  // in flight. Its late chunk is deliberately discarded, not counted as zero.
  if (summary.files.some(file => file.status === 'timeout')) return undefined;
  switch (recovery.status) {
  case 'completed': break;
  case 'running':
  case 'interrupted': return undefined;
  default: {
    const _ex: never = recovery.status;
    throw new Error(`Unhandled recovery status: ${_ex}`);
  }
  }
  // Model/planning failure is independent of metadata accounting. Refund a
  // finished collection even when a later investigation step failed, but never
  // infer zero transfer from a lost or interrupted checkpoint.
  switch (summary.status) {
  case 'complete':
  case 'partial': return summary.receivedBytes;
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
