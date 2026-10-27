import type { RemoteImageModelEditor } from '@/01-models/image-generation-preferences';
import type { RemoteImageModelFile } from '@/01-models/image-generation-history';
import { imageSelectionHintsSchema, type PeerImageCatalogItem } from '@/features/naidan-rpc-integration/contract';
import { componentMatch, componentRequirements, knownImageFamily } from './model-configuration';
import { reconcileImageComponents, type ImageSelectionCandidate, type ImageComponentSlot, type ImageSlotIntent } from './model-selection';
import { copyRemoteImageModelEditor, remoteImageFileKey } from './remote-image-model-editor';

/** A hint version is negotiated by the complete catalog, not one lucky item.
 * Missing/unknown hints retain the old manual catalog instead of guessing from
 * filenames, head-shard sizes, arrival order or provider-specific paths. */
export function remoteImageSelectionCandidates({ catalog }: { catalog: readonly PeerImageCatalogItem[] }): ImageSelectionCandidate[] | undefined {
  if (catalog.length > 256 || new Set(catalog.map(item => remoteImageFileKey({ file: item.file }))).size !== catalog.length) {
    return undefined;
  }
  const candidates: ImageSelectionCandidate[] = [];
  const ranks = new Set<number>();
  for (const item of catalog) {
    const parsed = imageSelectionHintsSchema.safeParse(item.selectionHints);
    if (!parsed.success || parsed.data.version !== 1 || !item.facts || new Set(item.roles).size !== item.roles.length) {
      return undefined;
    }
    const hints = parsed.data;
    if (hints.tieBreakRank >= catalog.length || ranks.has(hints.tieBreakRank)) {
      return undefined;
    }
    ranks.add(hints.tieBreakRank);
    candidates.push({
      key: remoteImageFileKey({ file: item.file }),
      repositoryGroup: hints.repositoryGroup,
      totalBytes: hints.totalBytes,
      tieBreakRank: hints.tieBreakRank,
      family: knownImageFamily({ family: item.facts.family }),
      classes: item.roles.includes('lora') ? [...item.facts.classes, 'lora'] : item.facts.classes,
      roles: item.roles.filter(role => role !== 'lora'),
      issue: undefined,
    });
  }
  return candidates;
}

/** expected metadata is a change detector, not a content hash. In particular,
 * this does not strengthen the provider's existing temporary-file policy. */
export function remoteImageFileMatches({ file, candidate }: { file: RemoteImageModelFile, candidate: RemoteImageModelFile }): boolean {
  return remoteImageFileKey({ file }) === remoteImageFileKey({ file: candidate })
    && (file.expected === undefined || file.expected.size === candidate.expected?.size && file.expected.lastModified === candidate.expected.lastModified);
}

export function remoteImagePrimaryItem({ editor, catalog }: { editor: RemoteImageModelEditor, catalog: readonly PeerImageCatalogItem[] }): PeerImageCatalogItem | undefined {
  const primary = editor.primary;
  if (!primary) {
    return undefined;
  }
  return catalog.find(item => remoteImageFileMatches({ file: primary.file, candidate: item.file }) && item.roles.includes(primary.slot)
    && (primary.family === undefined || primary.family === item.facts?.family));
}

export function reconcileRemoteImageEditor({ editor, catalog }: { editor: RemoteImageModelEditor, catalog: readonly PeerImageCatalogItem[] }): RemoteImageModelEditor {
  const candidates = remoteImageSelectionCandidates({ catalog });
  const primary = remoteImagePrimaryItem({ editor, catalog });
  // Never attach fresh companions to a primary that has changed underneath a
  // pinned editor, even when the path still happens to exist.
  if (!candidates || !primary) {
    return copyRemoteImageModelEditor({ editor });
  }
  const requirements = componentRequirements({ family: knownImageFamily({ family: primary.facts?.family }) });
  const choices: Partial<Record<ImageComponentSlot, ImageSlotIntent>> = {};
  const previous: Partial<Record<ImageComponentSlot, string>> = {};
  for (const requirement of requirements) {
    const component = editor.components.find(component => component.slot === requirement.slot);
    if (editor.automaticSlots.includes(requirement.slot)) {
      choices[requirement.slot] = { kind: 'automatic' };
      if (component && catalog.some(item => remoteImageFileMatches({ file: component.file, candidate: item.file }))) {
        previous[requirement.slot] = remoteImageFileKey({ file: component.file });
      }
    } else {
      choices[requirement.slot] = component ? { kind: 'file', key: remoteImageFileKey({ file: component.file }) } : { kind: 'none' };
    }
  }
  const resolved = reconcileImageComponents({ primaryKey: remoteImageFileKey({ file: primary.file }), candidates, choices, previous, recipe: undefined });
  const automaticSlots = editor.automaticSlots.filter(slot => requirements.some(requirement => requirement.slot === slot));
  const components = editor.components.filter(component => !automaticSlots.includes(component.slot));
  for (const component of resolved.components) {
    if (!automaticSlots.includes(component.slot)) {
      continue;
    }
    const item = catalog.find(item => remoteImageFileKey({ file: item.file }) === component.key);
    if (item) {
      components.push({ slot: component.slot, file: item.file });
    }
  }
  return copyRemoteImageModelEditor({ editor: { ...editor, components, automaticSlots } });
}

/** Only a complete, current catalog may disprove a saved reference. Without a
 * catalog, explicit configurations keep the existing generate-time validation.
 * Automatic selections additionally require supported, consistent hints. */
export function remoteImageEditorMatchesCatalog({ editor, catalog }: { editor: RemoteImageModelEditor, catalog: readonly PeerImageCatalogItem[] }): boolean {
  const primary = remoteImagePrimaryItem({ editor, catalog });
  if (!primary) {
    return false;
  }
  const requirements = componentRequirements({ family: knownImageFamily({ family: primary.facts?.family }) });
  if (editor.automaticSlots.length && (!remoteImageSelectionCandidates({ catalog })
    || editor.automaticSlots.some(slot => !requirements.some(requirement => requirement.slot === slot)))) {
    return false;
  }
  for (const component of editor.components) {
    const item = catalog.find(item => remoteImageFileMatches({ file: component.file, candidate: item.file }) && item.roles.includes(component.slot));
    if (!item) {
      return false;
    }
    const requirement = requirements.find(requirement => requirement.slot === component.slot);
    const status = requirement && item.facts ? componentMatch({ candidate: { family: item.facts.family, classes: item.facts.classes, roles: item.roles.filter(role => role !== 'lora'), issue: undefined }, requirement }) : 'unverified';
    if (status === 'incompatible' || editor.automaticSlots.includes(component.slot) && status !== 'matching') {
      return false;
    }
  }
  return editor.loras.every(lora => lora.enabled === 'disabled' || catalog.some(item => item.roles.includes('lora') && remoteImageFileMatches({ file: lora.file, candidate: item.file })));
}

export const TEST_ONLY = {
};
