export type NaidanLicense = Readonly<{
  id?: string,
  origin?: string,
  name: string,
  version: string | null,
  license: string | null,
  licenseText: string | null,
}>;

/** Browser list data deliberately excludes reconstructed license bodies. */
export type NaidanLicenseMetadata = Omit<NaidanLicense, 'licenseText'>;

/** Owned by the license section, never cached by the generated module. */
export type NaidanLicenseCatalog = Readonly<{
  entries: readonly NaidanLicenseMetadata[],
  readLicenseText: ({ index }: { index: number }) => string | null,
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
