import { expect, it } from 'vitest';
import type { RemoteImageModelEditor } from '@/01-models/image-generation-preferences';
import type { PeerImageCatalogItem } from '@/features/naidan-rpc-integration/contract';
import { remoteImageEditorReady, remoteImageFileKey, remoteImageModelChoices, remoteImageSelectionFromEditor } from './remote-image-model-editor';

function file({ path }: { path: string }) {
  return { location: { kind: 'opfs' as const, path } };
}
function editor(): RemoteImageModelEditor {
  return { primary: { slot: 'diffusion', file: file({ path: 'models/z-image.gguf' }), family: 'z-image' }, components: [], loras: [] };
}

it('requires the family-specific components without inserting another model', () => {
  const state = editor();
  expect(remoteImageEditorReady({ editor: state })).toBe(false);
  state.components = [{ slot: 'vae', file: file({ path: 'models/vae.gguf' }) }];
  expect(remoteImageEditorReady({ editor: state })).toBe(false);
  state.components.push({ slot: 'lm', file: file({ path: 'models/lm.gguf' }) });
  expect(remoteImageEditorReady({ editor: state })).toBe(true);
  expect(remoteImageSelectionFromEditor({ editor: state })?.components).toEqual(state.components);
});

it('keeps disabled adapters in the editor and omits them from the generation', () => {
  const state = editor();
  state.loras = [{ file: file({ path: 'models/off.gguf' }), strength: 0.7, enabled: 'disabled' }, { file: file({ path: 'models/on.gguf' }), strength: 0.4, enabled: 'enabled' }];
  const selection = remoteImageSelectionFromEditor({ editor: state });
  expect(selection?.loras).toEqual([{ file: file({ path: 'models/on.gguf' }), strength: 0.4 }]);
  expect(state.loras).toHaveLength(2);
});

it('does not treat an embedded checkpoint decoder or a different VAE family as a compatible component', () => {
  const catalog: PeerImageCatalogItem[] = [
    { label: 'checkpoint', file: file({ path: 'models/checkpoint.gguf' }), roles: ['model', 'vae'], facts: { family: 'sd-checkpoint', classes: ['vae-sd4'] } },
    { label: 'flux', file: file({ path: 'models/flux.gguf' }), roles: ['vae'], facts: { family: 'unknown', classes: ['vae-flux16'] } },
    { label: 'wrong', file: file({ path: 'models/wrong.gguf' }), roles: ['vae'], facts: { family: 'unknown', classes: ['vae-flux32'] } },
  ];
  expect(remoteImageModelChoices({ catalog, slot: 'vae', family: 'z-image' }).map(item => item.label)).toEqual(['flux']);
  expect(remoteImageModelChoices({ catalog, slot: 'primary', family: undefined }).map(item => item.label)).toEqual(['checkpoint']);
});

it('keeps unclassified components usable without claiming compatibility', () => {
  const catalog: PeerImageCatalogItem[] = [{ label: 'unclassified', file: file({ path: 'models/unclassified.gguf' }), roles: ['lm'] }];
  expect(remoteImageModelChoices({ catalog, slot: 'lm', family: 'z-image' })).toMatchObject([{ status: 'unverified' }]);
});

it('distinguishes a host directory from both another directory and this device', () => {
  const path = 'models/same.gguf';
  const keys = [file({ path }), { location: { kind: 'host' as const, directoryId: 'one', path } }, { location: { kind: 'host' as const, directoryId: 'two', path } }].map(file => remoteImageFileKey({ file }));
  expect(new Set(keys).size).toBe(3);
});

it('retains an explicit empty primary without manufacturing a valid request', () => {
  const state = editor(); state.primary = undefined;
  expect(remoteImageEditorReady({ editor: state })).toBe(false);
  expect(remoteImageSelectionFromEditor({ editor: state })).toBeUndefined();
});
