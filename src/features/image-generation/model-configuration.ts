import type { RemoteImageModelSelection } from '@/01-models/image-generation-history';

type ModelSlot = RemoteImageModelSelection['primary']['slot'] | RemoteImageModelSelection['components'][number]['slot'];

export type ImageFamily = 'sd-checkpoint' | 'z-image' | 'qwen-image-2.1' | 'flux1' | 'flux2-klein-4b' | 'anima' | 'krea2' | 'ernie-image' | 'unknown';
export type ComponentClass = 'vae-flux16' | 'vae-flux32' | 'vae-sd4' | 'vae-qwen21' | 'vae-wan16' | 'lm-qwen3-4b' | 'lm-qwen3-06b' | 'lm-qwen3vl-8b' | 'lm-qwen3vl-4b' | 'lm-ministral3-3b' | 'clip-l' | 'clip-g' | 't5-xxl' | 'other-lm' | 'other-vae' | 'lora';

export function componentRequirements({ family }: { family: ImageFamily }): { slot: ModelSlot, accepts: ComponentClass[], required: boolean }[] {
  switch (family) {
  case 'z-image': return [{ slot: 'vae', accepts: ['vae-flux16'], required: true }, { slot: 'lm', accepts: ['lm-qwen3-4b'], required: true }];
  case 'qwen-image-2.1': return [{ slot: 'vae', accepts: ['vae-qwen21'], required: true }, { slot: 'lm', accepts: ['lm-qwen3vl-8b'], required: true }];
  case 'flux1': return [{ slot: 'vae', accepts: ['vae-flux16'], required: true }, { slot: 'clipL', accepts: ['clip-l'], required: true }, { slot: 't5', accepts: ['t5-xxl'], required: true }];
  case 'flux2-klein-4b': return [{ slot: 'vae', accepts: ['vae-flux32'], required: true }, { slot: 'lm', accepts: ['lm-qwen3-4b'], required: true }];
  case 'anima': return [{ slot: 'vae', accepts: ['vae-wan16'], required: true }, { slot: 'lm', accepts: ['lm-qwen3-06b'], required: true }];
  case 'krea2': return [{ slot: 'vae', accepts: ['vae-wan16'], required: true }, { slot: 'lm', accepts: ['lm-qwen3vl-4b'], required: true }];
  case 'ernie-image': return [{ slot: 'vae', accepts: ['vae-flux32'], required: true }, { slot: 'lm', accepts: ['lm-ministral3-3b'], required: true }];
  case 'sd-checkpoint': return [{ slot: 'vae', accepts: ['vae-sd4'], required: false }];
  case 'unknown': return [];
  default: { const exhaustive: never = family; throw new Error(String(exhaustive)); }
  }
}
export function componentMatch({ candidate, requirement }: { candidate: { family: string, classes: readonly string[], roles: readonly ModelSlot[], issue: string | undefined }, requirement: { slot: ModelSlot, accepts: ComponentClass[] } }): 'matching' | 'unverified' | 'incompatible' {
  if (candidate.issue) return 'incompatible';
  // This selector supports standalone VAE files. Embedded decoder tensors do
  // not establish that a whole different checkpoint is usable as a VAE override.
  if (requirement.slot === 'vae' && candidate.family === 'sd-checkpoint') return 'incompatible';
  if (candidate.classes.some(value => requirement.accepts.some(accepted => accepted === value))) return 'matching';
  if (candidate.classes.length || candidate.roles.length && !candidate.roles.includes(requirement.slot)) return 'incompatible';
  return 'unverified';
}

/** Peer metadata describes evidence, not filesystem authority. Unknown families
 * keep all component slots editable without inventing required companions. */
export function knownImageFamily({ family }: { family: string | undefined }): ImageFamily {
  switch (family) {
  case 'sd-checkpoint': case 'z-image': case 'qwen-image-2.1': case 'flux1':
  case 'flux2-klein-4b': case 'anima': case 'krea2': case 'ernie-image': return family;
  default: return 'unknown';
  }
}

export const TEST_ONLY = {
};
