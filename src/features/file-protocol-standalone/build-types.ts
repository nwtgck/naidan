/** Node-free registration contract shared by feature packaging and the standalone plugin.
 * Keep it separate from the build implementation: app composite projects also typecheck
 * feature-owned build adapters, but must not pull in the standalone plugin graph. */
export type StandaloneEmbeddedBinary = Readonly<{
  virtualId: string;
  filePath: string;
  bytes: number;
  sha256: string;
}>;
export const TEST_ONLY = {
};
