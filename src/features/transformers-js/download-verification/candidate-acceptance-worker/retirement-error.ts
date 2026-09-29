import type { ProductionModelLoadAcceptanceResult } from '@/features/transformers-js/types';

/** Session verification settlement, including startup/lifecycle rejection.
 * Neither native-session entry nor helper acceptance is implied by this field. */
export type DownloadAcceptanceVerificationOutcome =
  | { status: 'not-settled' }
  | { status: 'fulfilled'; device: ProductionModelLoadAcceptanceResult['device']; dtype: ProductionModelLoadAcceptanceResult['dtype'] }
  | { status: 'rejected'; error: unknown };

/** Host-only ownership failure. Never serialize its causes as diagnostic text. */
export class DownloadAcceptanceWorkerRetirementError extends Error {
  readonly verificationOutcome: DownloadAcceptanceVerificationOutcome;
  readonly interruption: { reason: unknown } | undefined;

  constructor({ cause, verificationOutcome, interruption }: { cause: unknown; verificationOutcome: DownloadAcceptanceVerificationOutcome; interruption: { reason: unknown } | undefined }) {
    super('Download acceptance Worker could not be physically stopped', { cause });
    this.name = 'DownloadAcceptanceWorkerRetirementError';
    this.verificationOutcome = verificationOutcome;
    this.interruption = interruption;
  }
}

export const TEST_ONLY = {
};
