export type NaidanLicense = Readonly<{
  id?: string,
  origin?: string,
  name: string,
  version: string | null,
  license: string | null,
  licenseText: string | null,
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
