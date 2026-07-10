export type ExhaustiveObjectKeys<
  Expected extends object,
  Actual extends object,
> =
  & Record<Exclude<keyof Expected, keyof Actual>, never>
  & Record<Exclude<keyof Actual, keyof Expected>, never>;

export const exactObject =
  <Expected extends object>() =>
    // eslint-disable-next-line local-rules-named-args/require-named-args -- This type-only helper intentionally mirrors TypeScript's `satisfies` expression form.
    <Actual extends Expected>(
      actual: Actual & ExhaustiveObjectKeys<Expected, Actual>,
    ): Actual => actual;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
