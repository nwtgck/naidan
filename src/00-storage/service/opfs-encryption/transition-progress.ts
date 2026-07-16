export type OpfsEncryptionTransitionProgressOperation =
  | 'encrypting'
  | 'decrypting'
  | 'reencrypting';

export type OpfsEncryptionTransitionProgressPhase =
  | 'preparing'
  | 'copying'
  | 'verifying'
  | 'switching_authority'
  | 'cleaning_source'
  | 'finalizing';

export type OpfsEncryptionTransitionProgress = {
  readonly operation: OpfsEncryptionTransitionProgressOperation;
  readonly phase: OpfsEncryptionTransitionProgressPhase;
  readonly percent: number | undefined;
  readonly completedBytes: number;
  readonly totalBytes: number | undefined;
  readonly completedEntries: number;
  readonly totalEntries: number | undefined;
};

export type OpfsEncryptionTransitionProgressListener = ({ progress }: {
  progress: OpfsEncryptionTransitionProgress;
}) => void;

export function clampOpfsEncryptionTransitionPercent({
  percent,
}: {
  percent: number;
}): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
