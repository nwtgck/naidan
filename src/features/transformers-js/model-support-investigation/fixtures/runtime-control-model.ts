export const RUNTIME_CONTROL_FIXTURE_ID = 'identity-float32-v1';
export const RUNTIME_CONTROL_FIXTURE_SHA256 = '19be871867d45a5bb90b850518b38262a67d14cfccc147f6566f15308c273443';

const RUNTIME_CONTROL_MODEL_BYTES = [
  8, 8, 18, 22, 110, 97, 105, 100, 97, 110, 45, 114, 117, 110, 116, 105,
  109, 101, 45, 99, 111, 110, 116, 114, 111, 108, 58, 80, 10, 26, 10, 1,
  120, 18, 1, 121, 26, 8, 105, 100, 101, 110, 116, 105, 116, 121, 34, 8,
  73, 100, 101, 110, 116, 105, 116, 121, 18, 16, 105, 100, 101, 110, 116, 105,
  116, 121, 45, 99, 111, 110, 116, 114, 111, 108, 90, 15, 10, 1, 120, 18,
  10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1, 98, 15, 10, 1, 121, 18,
  10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1, 66, 4, 10, 0, 16, 13,
] as const;

export function createRuntimeControlModelBytes(): Uint8Array {
  return Uint8Array.from(RUNTIME_CONTROL_MODEL_BYTES);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
