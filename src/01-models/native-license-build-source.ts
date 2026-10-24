export type NativeLicenseRuntime = 'llama-cpp' | 'stable-diffusion-cpp';
export type NativeLicenseSource = Readonly<{
  runtime: NativeLicenseRuntime;
  rootDir: string;
  kind: 'installed' | 'external';
  manifestPaths: readonly string[];
  files: ReadonlySet<string>;
  readArtifact: ({ relative }: { relative: string }) => Readonly<{ data: Uint8Array; filePath: string }>;
}>;

export const TEST_ONLY = {
};
