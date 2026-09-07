export type ArgvValue = boolean | string | number;

export interface ArgvOptionEffect {
  readonly key: string,
  readonly value: ArgvValue,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
