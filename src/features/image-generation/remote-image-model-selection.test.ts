import { expect, it } from 'vitest';
import { imageCatalogItemSchema, imageSelectionHintsSchema } from '@/features/naidan-rpc-integration/contract';
import { imageSelectionCandidates } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import type { ModelCandidate } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { knownImageFamily } from './model-configuration';
import { chooseInitialImagePrimary, reconcileImageComponents } from './model-selection';
import { remoteImageSelectionFromEditor, remoteImageFileKey } from './remote-image-model-editor';
import { reconcileRemoteImageEditor, remoteImageEditorMatchesCatalog, remoteImageSelectionCandidates } from './remote-image-model-selection';
import { automaticImageEditor, imageCatalogFixture } from './model-selection.test-support';

it('fills companions with the same selection algorithm as the local candidate adapter', () => {
  const catalog = imageCatalogFixture({});
  const local: ModelCandidate[] = catalog.map(item => ({
    candidateKey: item.label,
    repositoryKey: 'test/repository',
    primaryRelativePath: item.file.location.path,
    roles: item.roles.filter(role => role !== 'lora'),
    classes: item.facts!.classes.filter(value => value === 'vae-flux16' || value === 'lm-qwen3-4b'),
    hostSource: undefined,
    format: 'gguf',
    size: imageSelectionHintsSchema.parse(item.selectionHints).totalBytes,
    family: knownImageFamily({ family: item.facts!.family }),
    variant: item.facts!.variant!,
    turboHint: item.facts!.variant === 'turbo',
    evidence: [],
    issue: undefined,
    files: [],
  }));
  // Provider publishes the source adapter's rank, not the serialized file key.
  const candidates = imageSelectionCandidates({ candidates: local });
  catalog.forEach(item => {
    item.selectionHints = { ...imageSelectionHintsSchema.parse(item.selectionHints), tieBreakRank: candidates.find(candidate => candidate.key === item.label)!.tieBreakRank };
  });
  const initial = chooseInitialImagePrimary({ candidates });
  const resolved = reconcileImageComponents({ primaryKey: initial, candidates, choices: {}, previous: {}, recipe: undefined });
  const remote = reconcileRemoteImageEditor({ editor: automaticImageEditor({ catalog }), catalog });
  expect(remote.components.map(component => component.slot)).toEqual(resolved.components.map(component => component.slot));
  expect(remoteImageEditorMatchesCatalog({ editor: remote, catalog })).toBe(true);
  expect(remoteImageSelectionFromEditor({ editor: remote })).not.toHaveProperty('automaticSlots');
});

it.each(['missing', 'future', 'duplicate-rank', 'bad-rank', 'duplicate-file', 'duplicate-role'] as const)('falls back to manual for %s hints', kind => {
  const catalog = imageCatalogFixture({});
  switch (kind) {
  case 'missing': delete catalog[1]!.selectionHints;
    break;
  case 'future': catalog[1]!.selectionHints = { version: 2 };
    break;
  case 'duplicate-rank': catalog[1]!.selectionHints = { ...imageSelectionHintsSchema.parse(catalog[1]!.selectionHints), tieBreakRank: 0 };
    break;
  case 'bad-rank': catalog[1]!.selectionHints = { ...imageSelectionHintsSchema.parse(catalog[1]!.selectionHints), tieBreakRank: 200 };
    break;
  case 'duplicate-file': catalog[1]!.file = catalog[0]!.file;
    break;
  case 'duplicate-role': catalog[1]!.roles.push('vae');
    break;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
  catalog.forEach(item => expect(imageCatalogItemSchema.safeParse(item).success).toBe(true));
  expect(remoteImageSelectionCandidates({ catalog })).toBeUndefined();
  const editor = automaticImageEditor({ catalog });
  expect(reconcileRemoteImageEditor({ editor, catalog })).toEqual(editor);
});

it('preserves pinned files and explicit none while refreshing automatic companions', () => {
  const catalog = imageCatalogFixture({});
  const editor = reconcileRemoteImageEditor({ editor: automaticImageEditor({ catalog }), catalog });
  editor.automaticSlots = ['lm'];
  editor.components = editor.components.filter(component => component.slot !== 'vae');
  const next = structuredClone(catalog);
  next[2]!.file.expected!.lastModified++;
  const refreshed = reconcileRemoteImageEditor({ editor, catalog: next });
  expect(refreshed.components.map(component => component.slot)).toEqual(['lm']);
  expect(refreshed.components[0]?.file.expected?.lastModified).toBe(43);
  const pinned = { ...editor, automaticSlots: [] };
  expect(reconcileRemoteImageEditor({ editor: pinned, catalog: next })).toEqual(pinned);
  expect(remoteImageEditorMatchesCatalog({ editor: pinned, catalog: next })).toBe(false);
});

it.each(['timestamp', 'size', 'family', 'role'] as const)('never mixes new companions with a pinned primary whose %s changed', kind => {
  const catalog = imageCatalogFixture({});
  const editor = reconcileRemoteImageEditor({ editor: automaticImageEditor({ catalog }), catalog });
  const next = structuredClone(catalog);
  next[1]!.file.expected!.lastModified++;
  switch (kind) {
  case 'timestamp': next[0]!.file.expected!.lastModified++;
    break;
  case 'size': next[0]!.file.expected!.size++;
    break;
  case 'family': next[0]!.facts!.family = 'anima';
    break;
  case 'role': next[0]!.roles = ['vae'];
    break;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
  expect(reconcileRemoteImageEditor({ editor, catalog: next })).toEqual(editor);
  expect(remoteImageEditorMatchesCatalog({ editor, catalog: next })).toBe(false);
});

it('excludes disabled adapters from availability checks and never selects adapters automatically', () => {
  const catalog = imageCatalogFixture({});
  const editor = reconcileRemoteImageEditor({ editor: automaticImageEditor({ catalog }), catalog });
  editor.loras.push({ file: { location: { kind: 'opfs', path: 'missing/adapter.gguf' } }, strength: 1, enabled: 'disabled' });
  expect(remoteImageEditorMatchesCatalog({ editor, catalog })).toBe(true);
  editor.loras[0]!.enabled = 'enabled';
  expect(remoteImageEditorMatchesCatalog({ editor, catalog })).toBe(false);
  catalog[1]!.roles.push('lora');
  const refreshed = reconcileRemoteImageEditor({ editor, catalog });
  expect(refreshed.components.some(component => component.slot === 'vae')).toBe(false);
  expect(refreshed.loras).toEqual(editor.loras);
});

it('does not auto-select a class-only candidate that lacks the required role', () => {
  const catalog = imageCatalogFixture({});
  catalog[1]!.roles = ['lm'];
  const editor = reconcileRemoteImageEditor({ editor: automaticImageEditor({ catalog }), catalog });
  expect(editor.components.map(component => component.slot)).toEqual(['lm']);
  expect(chooseInitialImagePrimary({ candidates: remoteImageSelectionCandidates({ catalog })! })).toBe(remoteImageFileKey({ file: catalog[0]!.file }));
});

export const TEST_ONLY = {
};
