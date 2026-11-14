import path from 'node:path';
import { readBicoreArtifactPackage } from '../../../build/bicore-artifact-package.ts';
import { chatProfileSchema, gpuProfilingProfile } from './types.ts';

/** Read only the reviewed llama subtree from the combined bicore package. */
export function readLlamaArtifactPackage({ rootDir }: { rootDir: string }) {
  const artifact = readBicoreArtifactPackage({
    directory: path.join(rootDir, 'node_modules/llama-cpp-browser-core'),
    runtime: 'llama-cpp',
    maxFileBytes: undefined,
  });
  return { ...artifact, profileRoot: path.join(artifact.runtimeRoot, 'profiles') };
}

/** A profiling extension is optional within the current bicore format.
 * Old package formats are rejected by the shared reader; partial profiles fail. */
export function hostedArtifactProfiles({ files, readArtifact }: { files: ReturnType<typeof readLlamaArtifactPackage>['files'], readArtifact: ReturnType<typeof readLlamaArtifactPackage>['readArtifact'] }) {
  const paths = ['core.mjs', 'core.wasm', 'core.d.ts'].map(name => `profiles/${gpuProfilingProfile}/browser/${name}`);
  const present = paths.filter(relative => files.has(relative));
  if (present.length === 0 && ![...files.keys()].some(relative => relative.startsWith(`profiles/${gpuProfilingProfile}/`))) {
    return [...chatProfileSchema.options];
  }
  if (present.length !== paths.length) {
    throw new Error('Incomplete GPU profiling artifact');
  }
  for (const relative of paths) {
    readArtifact({ relative });
  }
  return [...chatProfileSchema.options, gpuProfilingProfile];
}

/** The optional extension belongs to one profiling artifact. Never resolve a
 * package import for it: a current-format package may omit both sidecars. */
export function readQ8DiagnosticArtifact({ artifact }: { artifact: Pick<ReturnType<typeof readLlamaArtifactPackage>, 'files' | 'readArtifact'> }) {
  const prefix = `profiles/${gpuProfilingProfile}/browser/q8-diagnostic-v1`;
  const paths = [`${prefix}.schema.json`, `${prefix}.functions.d.ts`];
  const present = paths.filter(relative => artifact.files.has(relative));
  if (present.length === 0) {
    return undefined;
  }
  if (present.length !== paths.length) {
    throw new Error('Incomplete Q8 diagnostic extension artifact');
  }
  const relative = paths[0]!;
  const schema = artifact.readArtifact({ relative });
  artifact.readArtifact({ relative: paths[1]! });
  return { relative, ...schema };
}

export const TEST_ONLY = {
};
