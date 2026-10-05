import { z } from 'zod';
import type { RemoteImageModelEditor } from '@/01-models/image-generation-preferences';
import type { RemoteImageModelFile } from '@/01-models/image-generation-history';
import { imageFileSchema, imageComponentSlotSchema, imageModelSelectionSchema } from '@/features/naidan-peer-rpc/contract';
import type { PeerImageCatalogItem, PeerImageModelSelection } from '@/features/naidan-peer-rpc/contract';
import { componentMatch, componentRequirements, knownImageFamily } from './model-configuration';
import type { ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';

/** Runtime validation is independent of the loose persisted DTO. */
export const remoteImageModelEditorSchema = z.strictObject({
  primary: z.strictObject({ slot: z.enum(['model', 'diffusion']), file: imageFileSchema, family: z.string().min(1).max(64).optional() }).optional(),
  components: z.array(z.strictObject({ slot: imageComponentSlotSchema, file: imageFileSchema })).max(5)
    .refine(items => new Set(items.map(item => item.slot)).size === items.length),
  loras: z.array(z.strictObject({ file: imageFileSchema, strength: z.number().finite().min(-10).max(10), enabled: z.enum(['enabled', 'disabled']) })).max(8),
});

export function copyRemoteImageModelEditor({ editor }: { editor: RemoteImageModelEditor }): RemoteImageModelEditor {
  const { primary, components, loras, ...unhandled } = editor;
  unhandled satisfies Record<PropertyKey, never>;
  const parsed = remoteImageModelEditorSchema.parse({ primary, components, loras });
  return { primary: parsed.primary && { ...parsed.primary, family: parsed.primary.family }, components: parsed.components, loras: parsed.loras };
}

export function emptyRemoteImageModelEditor(): RemoteImageModelEditor {
  return { primary: undefined, components: [], loras: [] };
}

export function remoteImageFileKey({ file }: { file: RemoteImageModelFile }): string {
  const { location, expected: _expected, ...unhandled } = file;
  unhandled satisfies Record<PropertyKey, never>;
  switch (location.kind) {
  case 'opfs': {
    const { kind, path, ...unhandledLocation } = location;
    unhandledLocation satisfies Record<PropertyKey, never>;
    return JSON.stringify([kind, path]);
  }
  case 'host': {
    const { kind, directoryId, path, ...unhandledLocation } = location;
    unhandledLocation satisfies Record<PropertyKey, never>;
    return JSON.stringify([kind, directoryId, path]);
  }
  default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
  }
}

export function remoteImageEditorFromSelection({ selection, family }: { selection: PeerImageModelSelection, family: string | undefined }): RemoteImageModelEditor {
  const { primary, components, loras, ...unhandled } = imageModelSelectionSchema.parse(selection);
  unhandled satisfies Record<PropertyKey, never>;
  return { primary: { ...primary, family }, components, loras: loras.map(item => ({ ...item, enabled: 'enabled' })) };
}

export function remoteImageSelectionFromEditor({ editor }: { editor: RemoteImageModelEditor }): PeerImageModelSelection | undefined {
  const { primary, components, loras, ...unhandled } = editor;
  unhandled satisfies Record<PropertyKey, never>;
  if (!primary) return undefined;
  const { family: _family, ...selectedPrimary } = primary;
  return imageModelSelectionSchema.parse({ primary: selectedPrimary, components, loras: loras.flatMap(item => {
    const { file, strength, enabled, ...unhandledLora } = item;
    unhandledLora satisfies Record<PropertyKey, never>;
    switch (enabled) {
    case 'enabled': return [{ file, strength }];
    case 'disabled': return [];
    default: { const exhaustive: never = enabled; throw new Error(String(exhaustive)); }
    }
  }) });
}

export function remoteImageEditorReady({ editor }: { editor: RemoteImageModelEditor }): boolean {
  if (!editor.primary) return false;
  const required = componentRequirements({ family: knownImageFamily({ family: editor.primary.family }) });
  if (required.some(item => item.required && !editor.components.some(component => component.slot === item.slot))) return false;
  try {
    return remoteImageSelectionFromEditor({ editor }) !== undefined;
  } catch {
    return false;
  }
}

export function remoteImageModelChoices({ catalog, slot, family }: {
  catalog: readonly PeerImageCatalogItem[], slot: 'primary' | RemoteImageModelEditor['components'][number]['slot'] | 'lora', family: string | undefined,
}): ImageModelChoice[] {
  const requirement = componentRequirements({ family: knownImageFamily({ family }) }).find(item => item.slot === slot);
  return catalog.flatMap(item => {
    const roleMatches = (() => {
      switch (slot) {
      case 'primary': return item.roles.includes('model') || item.roles.includes('diffusion');
      case 'lora': case 'vae': case 'clipL': case 'clipG': case 't5': case 'lm': return item.roles.includes(slot);
      default: { const exhaustive: never = slot; throw new Error(String(exhaustive)); }
      }
    })();
    if (!roleMatches) return [];
    const status = requirement && item.facts ? componentMatch({
      candidate: { family: item.facts.family, classes: item.facts.classes, roles: item.roles.filter(role => role !== 'lora'), issue: undefined }, requirement,
    }) : 'unverified';
    // Keep known incompatible files out of normal choices. The user's saved
    // selection is retained separately, never substituted by a catalog refresh.
    switch (status) {
    case 'incompatible': return [];
    case 'matching': case 'unverified': break;
    default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
    }
    return [{ id: remoteImageFileKey({ file: item.file }), label: item.label, detail: item.file.location.path,
      evidence: [], status, issue: undefined }];
  });
}

export const TEST_ONLY = {
};
