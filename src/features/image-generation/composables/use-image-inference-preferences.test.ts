import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { DEFAULT_SETTINGS, type Settings, type BrowserImageGenerationSettings } from '@/01-models/types';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId, toBinaryObjectId } from '@/01-models/ids';
import type { RemoteImageModelEditorPreference } from '@/01-models/image-generation-preferences';
import { createImageForm } from '@/features/image-generation/form';
import { useImageInferenceLocation } from './use-image-inference-location';
import { useImageInferencePreferences } from './use-image-inference-preferences';

const rpc = vi.hoisted(() => ({ bind: vi.fn() }));
vi.mock('@/features/naidan-peer-rpc/runtime/feature', () => ({
  subscribeRpcState: () => () => {},
  getRpcManager: async () => ({ list: () => [], reload: async () => {}, bindClient: rpc.bind }),
}));
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop(); vi.clearAllMocks();
});
function preference({ name }: { name: 'one' | 'two' }): RemoteImageModelEditorPreference {
  return {
    connectionId: toNaidanRpcConnectionId({ raw: `connection-${name}` }),
    peerId: toNaidanRpcPeerId({ raw: (name === 'one' ? 'B' : 'C').repeat(43) }),
    editor: {
      primary: { slot: 'model', file: { location: { kind: 'host', directoryId: 'remote-root', path: 'models/main.gguf' } }, family: 'sd-checkpoint' },
      components: [],
      loras: [{ file: { location: { kind: 'opfs', path: 'models/off.gguf' } }, strength: 0.7, enabled: 'disabled' }],
    },
  };
}
function saved(): BrowserImageGenerationSettings {
  const one = preference({ name: 'one' });
  return { width: 768, inferenceLocation: { kind: 'naidan_rpc', connection: { connectionId: one.connectionId, peerId: one.peerId } }, remoteModelEditors: [one] };
}
function harness({ preferences }: { preferences: BrowserImageGenerationSettings }) {
  const scope = effectScope(); scopes.push(scope);
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'local', endpoint: { type: 'openai', url: '' }, experimental: { locale: 'en', browserImageGeneration: preferences } });
  let generation = 0;
  const update = vi.fn(async ({ isCurrent, updater }: {
    isCurrent(): boolean, updater({ experimental }: { experimental: Settings['experimental'] }): Settings['experimental'],
  }): Promise<'saved' | 'changed'> => {
    if (!isCurrent()) return 'changed';
    settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
    return 'saved';
  });
  const failed = vi.fn();
  const inferenceLocation = scope.run(() => {
    const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' });
    const inferenceLocation = useImageInferenceLocation({ form, blocked: () => false, identifyInput: () => toBinaryObjectId({ raw: 'image-input' }) });
    useImageInferencePreferences({
      settings,
      initialized: ref(true),
      inferenceLocation,
      captureStorage() {
      const captured = generation; return () => captured === generation;
    },
      updateForStorage: update,
      failed,
    });
    return inferenceLocation;
  })!;
  return {
    inferenceLocation,
    settings,
    update,
    failed,
    scope,
    replaceStorage() {
    generation++;
  },
  };
}
async function settle(): Promise<void> {
  await nextTick(); await Promise.resolve(); await nextTick();
}
it('restores the inferenceLocation and disabled adapters without saving, connecting or generating', async () => {
  const h = harness({ preferences: saved() }); await settle();
  expect(h.inferenceLocation.kind.value).toBe('naidan_rpc'); expect(h.inferenceLocation.editor.value.loras[0]?.enabled).toBe('disabled');
  expect(h.inferenceLocation.selection.value?.loras).toEqual([]); expect(h.update).not.toHaveBeenCalled(); expect(rpc.bind).not.toHaveBeenCalled();
});
it('persists explicit clearing while retaining concurrent settings and another peer editor', async () => {
  const h = harness({ preferences: saved() }); await settle();
  const two = preference({ name: 'two' });
  h.settings.value.experimental = { ...h.settings.value.experimental, locale: 'ja', browserImageGeneration: { ...h.settings.value.experimental?.browserImageGeneration, height: 1024, remoteModelEditors: [preference({ name: 'one' }), two] } };
  h.inferenceLocation.choosePrimary({ id: '' }); await settle();
  const actual = h.settings.value.experimental?.browserImageGeneration;
  expect(actual).toMatchObject({ width: 768, height: 1024 }); expect(h.settings.value.experimental?.locale).toBe('ja');
  expect(actual?.remoteModelEditors?.find(item => item.connectionId === preference({ name: 'one' }).connectionId)?.editor.primary).toBeUndefined();
  expect(actual?.remoteModelEditors?.find(item => item.connectionId === two.connectionId)).toEqual(two);
  const reopened = harness({ preferences: actual! }); await settle(); expect(reopened.inferenceLocation.editor.value.primary).toBeUndefined();
});
it('combines failed and newer edits without resetting the user inferenceLocation', async () => {
  const h = harness({ preferences: saved() }); await settle();
  h.update.mockRejectedValueOnce(new Error('disk full'));
  h.inferenceLocation.changeLora({ index: 0, enabled: 'enabled', strength: 0.2 }); await settle();
  expect(h.failed).toHaveBeenCalledOnce();
  h.inferenceLocation.changeLora({ index: 0, enabled: 'disabled', strength: 0.8 }); h.inferenceLocation.setKind({ value: 'local' }); await settle();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({ inferenceLocation: { kind: 'local' }, remoteModelEditors: [{ editor: { loras: [{ enabled: 'disabled', strength: 0.8 }] } }] });
});
it('discards queued edits when the settings provider changes while a write waits', async () => {
  const h = harness({ preferences: saved() }); await settle();
  const gate = Promise.withResolvers<void>();
  h.update.mockImplementationOnce(async ({ isCurrent, updater }) => {
    await gate.promise;
    if (!isCurrent()) return 'changed';
    h.settings.value = { ...h.settings.value, experimental: updater({ experimental: h.settings.value.experimental }) }; return 'saved';
  });
  h.inferenceLocation.changeLora({ index: 0, enabled: 'enabled', strength: 0.3 }); await settle();
  h.inferenceLocation.setKind({ value: 'local' }); await settle();
  h.replaceStorage(); h.settings.value.experimental = { browserImageGeneration: { width: 1024 } }; gate.resolve(); await settle();
  expect(h.settings.value.experimental).toEqual({ browserImageGeneration: { width: 1024 } }); expect(h.update).toHaveBeenCalledOnce(); expect(h.failed).not.toHaveBeenCalled();
});
it('resumes new provider edits while an obsolete save still owns its cleanup', async () => {
  const h = harness({ preferences: saved() }); await settle();
  const gate = Promise.withResolvers<void>();
  h.update.mockImplementationOnce(async ({ isCurrent }) => {
    await gate.promise; return isCurrent() ? 'saved' : 'changed';
  });
  h.inferenceLocation.changeLora({ index: 0, enabled: 'enabled', strength: 0.3 }); await settle();
  h.replaceStorage();
  const two = preference({ name: 'two' });
  h.settings.value.experimental = {
    browserImageGeneration: {
    width: 1024,
    inferenceLocation: { kind: 'naidan_rpc', connection: { connectionId: two.connectionId, peerId: two.peerId } },
    remoteModelEditors: [two],
  },
  };
  await settle(); expect(h.update).toHaveBeenCalledOnce();
  expect(h.inferenceLocation.connectionId.value).toBe(two.connectionId);
  h.inferenceLocation.changeLora({ index: 0, enabled: 'enabled', strength: 0.9 }); h.inferenceLocation.setKind({ value: 'local' }); await settle();
  gate.resolve(); await settle();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({
    width: 1024,
    inferenceLocation: { kind: 'local' },
    remoteModelEditors: [{ connectionId: two.connectionId, editor: { loras: [{ enabled: 'enabled', strength: 0.9 }] } }],
  });
  expect(h.settings.value.experimental?.browserImageGeneration?.remoteModelEditors).toHaveLength(1);
  expect(h.update).toHaveBeenCalledTimes(2); expect(h.failed).not.toHaveBeenCalled();
});
it('drains accepted edits after leaving the view when storage still belongs to it', async () => {
  const h = harness({ preferences: saved() }); await settle();
  const gate = Promise.withResolvers<void>();
  h.update.mockImplementationOnce(async ({ isCurrent, updater }) => {
    await gate.promise; if (!isCurrent()) return 'changed';
    h.settings.value = { ...h.settings.value, experimental: updater({ experimental: h.settings.value.experimental }) }; return 'saved';
  });
  h.inferenceLocation.setKind({ value: 'local' }); await settle();
  h.inferenceLocation.changeLora({ index: 0, enabled: 'enabled', strength: 0.9 }); await settle(); h.scope.stop(); gate.resolve(); await settle();
  expect(h.settings.value.experimental?.browserImageGeneration).toMatchObject({ inferenceLocation: { kind: 'local' }, remoteModelEditors: [{ editor: { loras: [{ enabled: 'enabled', strength: 0.9 }] } }] });
});
