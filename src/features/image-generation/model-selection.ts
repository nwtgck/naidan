import { componentMatch, componentRequirements, type ImageFamily } from './model-configuration';
import type { RemoteImageModelSelection } from '@/01-models/image-generation-history';

export type ImageComponentSlot = RemoteImageModelSelection['components'][number]['slot'];
type PrimarySlot = RemoteImageModelSelection['primary']['slot'];

/** Facts only: no Files, network calls, Vue state or persisted formats. */
export type ImageSelectionCandidate = {
  key: string,
  repositoryGroup: string | number,
  totalBytes: number,
  tieBreakRank: number,
  family: ImageFamily,
  roles: readonly (PrimarySlot | ImageComponentSlot)[],
  classes: readonly string[],
  issue: string | undefined,
};
export type ImageSlotIntent = { kind: 'automatic' } | { kind: 'none' } | { kind: 'file', key: string };
export type ResolvedImageComponent = {
  slot: ImageComponentSlot,
  key: string | undefined,
  required: boolean,
  status: 'matching' | 'unverified' | 'incompatible' | 'missing',
};

export function imagePrimarySlot({ family }: { family: ImageFamily }): PrimarySlot | undefined {
  switch (family) {
  case 'sd-checkpoint': return 'model';
  case 'z-image': case 'qwen-image-2.1': case 'flux1': case 'flux2-klein-4b': case 'anima': case 'krea2': case 'ernie-image': return 'diffusion';
  case 'unknown': return undefined;
  default: {
    const exhaustive: never = family;
    throw new Error(String(exhaustive));
  }
  }
}

export function chooseInitialImagePrimary({ candidates }: { candidates: readonly ImageSelectionCandidate[] }): string | undefined {
  return candidates.filter(candidate => {
    const slot = imagePrimarySlot({ family: candidate.family });
    return slot !== undefined && !candidate.issue && candidate.roles.includes(slot) && !candidate.classes.includes('lora');
  }).sort((a, b) => a.totalBytes - b.totalBytes || a.tieBreakRank - b.tieBreakRank)[0]?.key;
}

function isAutomaticMatch({ candidate, primary, requirement }: {
  candidate: ImageSelectionCandidate, primary: ImageSelectionCandidate,
  requirement: ReturnType<typeof componentRequirements>[number],
}): boolean {
  // A matching class alone is not sufficient: the requested role must exist.
  return candidate.key !== primary.key && !candidate.classes.includes('lora') && candidate.roles.includes(requirement.slot)
    && componentMatch({ candidate, requirement }) === 'matching';
}

export function chooseImageCompanion({ primary, candidates, requirement }: {
  primary: ImageSelectionCandidate, candidates: readonly ImageSelectionCandidate[],
  requirement: ReturnType<typeof componentRequirements>[number],
}): string | undefined {
  // Size is a storage-footprint preference, not a speed or quality estimate.
  return candidates.filter(candidate => isAutomaticMatch({ candidate, primary, requirement }))
    .sort((a, b) => Number(b.repositoryGroup === primary.repositoryGroup) - Number(a.repositoryGroup === primary.repositoryGroup)
      || a.totalBytes - b.totalBytes || a.tieBreakRank - b.tieBreakRank)[0]?.key;
}

export function reconcileImageComponents({ primaryKey, candidates, choices, previous, recipe }: {
  primaryKey: string | undefined,
  candidates: readonly ImageSelectionCandidate[],
  choices: Readonly<Partial<Record<ImageComponentSlot, ImageSlotIntent>>>,
  previous: Readonly<Partial<Record<ImageComponentSlot, string>>>,
  // Presence of a recipe disables previous-choice retention. An empty key is
  // an unavailable recipe file, never permission to substitute another file.
  recipe: Readonly<Partial<Record<ImageComponentSlot, string>>> | undefined,
}): { components: ResolvedImageComponent[], missingRequiredSlots: ImageComponentSlot[], ready: boolean } {
  const primary = candidates.find(candidate => candidate.key === primaryKey);
  const slot = primary && imagePrimarySlot({ family: primary.family });
  if (!primary || primary.issue || !slot || !primary.roles.includes(slot) || primary.classes.includes('lora')) {
    return { components: [], missingRequiredSlots: [], ready: false };
  }
  const components = componentRequirements({ family: primary.family }).map(requirement => {
    const choice = choices[requirement.slot] ?? { kind: 'automatic' };
    const key = (() => {
      switch (choice.kind) {
      case 'file': return choice.key;
      case 'none': return undefined;
      case 'automatic': {
        const requested = recipe?.[requirement.slot];
        if (requested !== undefined) {
          const candidate = candidates.find(candidate => candidate.key === requested);
          return candidate && !isAutomaticMatch({ candidate, primary, requirement }) ? '' : requested;
        }
        const retained = recipe === undefined ? candidates.find(candidate => candidate.key === previous[requirement.slot]) : undefined;
        if (retained && isAutomaticMatch({ candidate: retained, primary, requirement })) {
          return retained.key;
        }
        // A complete checkpoint uses its embedded VAE unless explicitly overridden.
        return requirement.required ? chooseImageCompanion({ primary, candidates, requirement }) : undefined;
      }
      default: {
        const exhaustive: never = choice;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const candidate = candidates.find(item => item.key === key);
    return {
      slot: requirement.slot,
      key,
      required: requirement.required,
      status: candidate ? componentMatch({ candidate, requirement }) : 'missing' as const,
    };
  });
  return {
    components,
    missingRequiredSlots: components.filter(component => component.required && component.status === 'missing').map(component => component.slot),
    ready: components.every(component => (!component.required && component.key === undefined) || component.status === 'matching' || component.status === 'unverified'),
  };
}

export const TEST_ONLY = {
};
