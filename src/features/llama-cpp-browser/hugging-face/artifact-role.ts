import { isProjector } from './model-variants';

export type GgufArtifactRole = 'model' | 'projector' | 'auxiliary';

/** File-name hints are deliberately conservative; they are not GGUF metadata. */
export function artifactRole({ path }: { path: string }): GgufArtifactRole {
  if (isProjector({ path })) return 'projector';
  // Match path components/tokens, not arbitrary substrings in a model's name.
  // These are companions, never a substitute for the main model in one-click selection.
  if (/(?:^|[/_.-])(?:dflash|mtp|eagle[0-9]*|draft|drafter)(?=[/_.-]|$)/i.test(path)) return 'auxiliary';
  return 'model';
}

export const TEST_ONLY = {
};
