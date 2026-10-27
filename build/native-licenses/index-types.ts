/** Stable structural contract. Paths are runtime-package-relative, never URLs.
 * Additive metadata is allowed. Never change an existing field's meaning in place.
 */
export type NativeLicenseIndex = Readonly<{
  components: readonly Readonly<{
    id: string;
    name: string;
    version: string | null;
    license: string | null;
    notices: readonly Readonly<{
      path: string;
      sourcePath?: string;
    }>[];
  }>[];
}>;

export const TEST_ONLY = {
};
