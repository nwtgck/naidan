export type OpfsEncryptionUnlockButtonState =
  | 'ready'
  | 'retracting'
  | 'seating'
  | 'unlocked';

export const OPFS_ENCRYPTION_UNLOCK_RETRACT_DURATION_MS = 720;
export const OPFS_ENCRYPTION_UNLOCK_MINIMUM_SEAT_START_MS = 880;
export const OPFS_ENCRYPTION_UNLOCK_SUCCESS_ANIMATION_DURATION_MS = 190;
export const OPFS_ENCRYPTION_UNLOCK_POST_SUCCESS_HOLD_DURATION_MS = 250;
export const OPFS_ENCRYPTION_UNLOCK_REDUCED_MOTION_DURATION_MS = 1;


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
