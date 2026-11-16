/** Published package identity, not proof of the live transformed module bytes. */
export function runtimeBuildEvidence({ manifest, runtimeManifest }: {
  manifest: { formatVersion: number; sourceCommit: string };
  runtimeManifest: { formatVersion: number; runtime: string; sourceCommit: string; files: readonly { path: string; bytes: number; sha256: string }[] };
}) {
  if ((manifest.formatVersion !== 5 && manifest.formatVersion !== 6) || runtimeManifest.formatVersion !== 2 || runtimeManifest.runtime !== 'llama-cpp' || manifest.sourceCommit !== runtimeManifest.sourceCommit) {
    return undefined;
  }
  return {
    sourceCommit: manifest.sourceCommit,
    files: runtimeManifest.files.filter(file => file.path.startsWith('profiles/') || file.path.startsWith('api/'))
      .map(file => ({ path: `runtimes/llama-cpp-browser-core/${file.path}`, bytes: file.bytes, sha256: file.sha256 })),
  };
}

export const TEST_ONLY = {
};
