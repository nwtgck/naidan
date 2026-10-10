import { z } from 'zod';
import type { PerformanceSnapshot } from './types';

const manifestSchema = z.object({
  formatVersion: z.literal(3),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
});

/** Published package identity, not proof of the live transformed module bytes. */
export function runtimeBuildEvidence({ manifest }: { manifest: unknown }): PerformanceSnapshot['environment']['runtimeBuild'] {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) return undefined;
  return {
    sourceCommit: parsed.data.sourceCommit,
    files: parsed.data.files.filter(file =>
      file.path.startsWith('llama-cpp-browser-core/profiles/') || file.path.startsWith('llama-cpp-browser-core/api/')),
  };
}

export const TEST_ONLY = {
};
