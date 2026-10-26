import type { PeerImageCatalogItem } from '@/features/naidan-rpc-integration/contract';
import type { RemoteImageModelEditor } from '@/01-models/image-generation-preferences';
import { componentRequirements, type ImageFamily } from './model-configuration';
import { imagePrimarySlot, type ImageSelectionCandidate } from './model-selection';

export function imageSelectionCandidate({ key, ...overrides }: {
  key: string, repositoryGroup?: ImageSelectionCandidate['repositoryGroup'], totalBytes?: number, tieBreakRank?: number,
  family?: ImageFamily, roles?: ImageSelectionCandidate['roles'], classes?: readonly string[], issue?: string,
}): ImageSelectionCandidate {
  return { key, repositoryGroup: 'repository', totalBytes: 100, tieBreakRank: 0, family: 'unknown', roles: [], classes: [], issue: undefined, ...overrides };
}

export function imageCatalogFixture({ family = 'z-image', variant = 'turbo' }: { family?: ImageFamily, variant?: 'turbo' | 'base' | 'distilled' | 'unknown' }): PeerImageCatalogItem[] {
  const entries = [
    { name: 'primary', family, classes: [], roles: [imagePrimarySlot({ family }) ?? 'diffusion'] },
    ...componentRequirements({ family }).map(requirement => ({ name: requirement.slot, family: 'unknown', classes: requirement.accepts.slice(0, 1), roles: [requirement.slot] })),
  ];
  return entries.map((entry, index) => ({
    label: entry.name,
    file: { location: { kind: 'opfs', path: `models/test/${entry.name}.gguf` }, expected: { size: 100 + index, lastModified: 42 } },
    roles: entry.roles,
    facts: { family: entry.family, classes: entry.classes, variant: index === 0 ? variant : 'unknown', evidence: ['header'] },
    selectionHints: { version: 1, repositoryGroup: 0, totalBytes: 100 + index, tieBreakRank: index },
  }));
}

export function automaticImageEditor({ catalog }: { catalog: PeerImageCatalogItem[] }): RemoteImageModelEditor {
  return {
    primary: { slot: catalog[0]!.roles.includes('model') ? 'model' : 'diffusion', file: catalog[0]!.file, family: catalog[0]!.facts!.family },
    components: [],
    loras: [],
    automaticSlots: ['vae', 'lm'],
  };
}

export const TEST_ONLY = {
};
