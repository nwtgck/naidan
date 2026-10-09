import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { generateId } from '@/01-models/id';
import { idToRaw, type BinaryObjectId, type NaidanRpcRegistrationId, type NaidanRpcPeerPublicKey, type ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationDraftRequest } from '@/01-models/image-generation';
import type { ImageGenerationRemoteRuntime } from '@/01-models/image-generation-history';
import type { ImageInferenceLocationPreference, RemoteImageModelEditor, RemoteImageModelEditorPreference } from '@/01-models/image-generation-preferences';
import type { createImageForm } from '@/features/image-generation/form';
import type { ImageGenerationSnapshot, HistoryBinaryFile } from '@/features/image-generation/history/snapshot';
import { copyImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import type { PreparedImageExecution } from '@/features/image-generation/execution/types';
import { imageModelSelectionSchema, peerImageParametersSchema, peerImagePreviewSchema } from '@/features/naidan-rpc-integration/contract';
import type { PeerImageCatalogItem } from '@/features/naidan-rpc-integration/contract';
import { preparePeerImageExecution } from '@/features/naidan-rpc-integration/adapters/image-execution';
import { getRpcManager, subscribeRpcState } from '@/features/naidan-rpc-integration/runtime/feature';
import type { RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import { copyRemoteImageModelEditor, emptyRemoteImageModelEditor, remoteImageEditorFromSelection, remoteImageEditorReady, remoteImageFileKey, remoteImageModelChoices, remoteImageSelectionFromEditor } from '@/features/image-generation/remote-image-model-editor';
import { componentRequirements, knownImageFamily } from '@/features/image-generation/model-configuration';
import type { ImageComponentChoice, ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';

/** Selection is draft state. Neither selection, restore nor refresh connects a
 * peer. Model references are always scoped to a verified remote identity. */
export function useImageInferenceLocation({ form, blocked, identifyInput }: {
  form: ReturnType<typeof createImageForm>, blocked(): boolean,
  identifyInput({ file }: { file: File }): BinaryObjectId,
}) {
  const kind = ref<'local' | 'naidan_rpc'>('local');
  const unavailable = ref(false);
  const isRemote = computed(() => {
    switch (kind.value) {
    case 'local': return false;
    case 'naidan_rpc': return true;
    default: { const exhaustive: never = kind.value; throw new Error(String(exhaustive)); }
    }
  });
  const registrationId = ref<NaidanRpcRegistrationId>();
  const peerPublicKey = ref<NaidanRpcPeerPublicKey>();
  const label = ref('');
  const editor = shallowRef<RemoteImageModelEditor>(emptyRemoteImageModelEditor());
  const editors = shallowRef<RemoteImageModelEditorPreference[]>([]);
  const durableReferences = new Set<string>();
  const selection = computed(() => remoteImageSelectionFromEditor({ editor: editor.value }));
  const ready = computed(() => remoteImageEditorReady({ editor: editor.value }));
  const entries = shallowRef<RpcRegistrationView[]>([]);
  const catalog = shallowRef<PeerImageCatalogItem[]>([]);
  const loading = ref(false), failure = ref('');
  let disposed = false, catalogEpoch = 0, refreshEpoch = 0;
  let catalogStop: AbortController | undefined;
  const selected = computed(() => entries.value.find(item => item.registration.id === registrationId.value));
  const connected = computed(() => selected.value?.phase === 'connected' && selected.value.registration.peerPublicKey === peerPublicKey.value);
  const unsubscribe = subscribeRpcState({
    listener() {
      if (isRemote.value) void refresh({ fromStorage: false });
    },
  });
  onScopeDispose(() => {
    disposed = true; catalogStop?.abort(); unsubscribe();
  });
  function discardCatalog(): void {
    catalogEpoch++; catalogStop?.abort(); catalogStop = undefined; catalog.value = []; loading.value = false;
  }
  function chooseRegistration({ id }: { id: NaidanRpcRegistrationId | undefined }): void {
    if (blocked()) return;
    discardCatalog(); unavailable.value = false; registrationId.value = id;
    const next = entries.value.find(item => item.registration.id === id);
    peerPublicKey.value = next?.registration.peerPublicKey; label.value = next?.registration.label ?? '';
    const saved = editors.value.find(item => item.registrationId === id && item.peerPublicKey === peerPublicKey.value);
    editor.value = saved ? copyRemoteImageModelEditor({ editor: saved.editor }) : emptyRemoteImageModelEditor();
    failure.value = '';
  }
  async function refresh({ fromStorage }: { fromStorage: boolean }): Promise<void> {
    const epoch = ++refreshEpoch;
    try {
      const manager = await getRpcManager();
      if (fromStorage) await manager.reload();
      if (!disposed && epoch === refreshEpoch) entries.value = manager.list();
    } catch (error) {
      if (!disposed && epoch === refreshEpoch) {
        entries.value = []; failure.value = error instanceof Error ? error.message : String(error);
      }
    }
  }
  watch(kind, () => {
    discardCatalog();
    if (isRemote.value) void refresh({ fromStorage: true });
  }, { flush: 'sync' });
  async function loadModels(): Promise<void> {
    if (blocked() || !registrationId.value || !peerPublicKey.value || loading.value) return;
    discardCatalog(); const epoch = catalogEpoch, id = registrationId.value, expectedPeer = peerPublicKey.value;
    const stop = new AbortController(); catalogStop = stop; loading.value = true; failure.value = '';
    try {
      const binding = (await getRpcManager()).bindClient({ id });
      stop.signal.throwIfAborted();
      if (binding.registration.peerPublicKey !== expectedPeer) throw new Error('The selected peer identity changed');
      const sessionSignal = AbortSignal.any([stop.signal, binding.signal]);
      const call = binding.client.listImageModels({ input: {}, on: {}, signal: sessionSignal, timeoutMs: undefined });
      void call.closed.catch(() => {});
      try {
        const stream = await call.result, reader = stream.getReader();
        const items: PeerImageCatalogItem[] = [];
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            if (items.length >= 256) throw new Error('Remote image catalog exceeds its limit');
            items.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
        await call.closed;
        if (!disposed && epoch === catalogEpoch) {
          sessionSignal.throwIfAborted();
          if (new Set(items.map(item => remoteImageFileKey({ file: item.file }))).size !== items.length) throw new Error('Duplicate remote image catalog file');
          catalog.value = items;
        }
      } catch (error) {
        call.cancel({ reason: 'Image catalog stopped' }); throw error;
      }
    } catch (error) {
      if (!disposed && epoch === catalogEpoch) failure.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (!disposed && epoch === catalogEpoch) loading.value = false;
    }
  }
  function selectModel({ value }: { value: unknown }): void {
    if (blocked()) return;
    const parsed = imageModelSelectionSchema.parse(value);
    const item = catalog.value.find(item => remoteImageFileKey({ file: item.file }) === remoteImageFileKey({ file: parsed.primary.file }));
    setEditor({ value: remoteImageEditorFromSelection({ selection: parsed, family: item?.facts?.family }) });
  }
  function setEditor({ value }: { value: RemoteImageModelEditor }): void {
    const copied = copyRemoteImageModelEditor({ editor: value });
    const id = registrationId.value, peer = peerPublicKey.value;
    if (id && peer) {
      const previous = editors.value.find(item => item.registrationId === id && item.peerPublicKey === peer);
      if (!previous && editors.value.length >= 32) throw new Error('Too many saved remote model editors');
      editors.value = [...editors.value.filter(item => item !== previous), { registrationId: id, peerPublicKey: peer, editor: copied }];
    }
    editor.value = copied;
  }
  function choices({ slot, file }: { slot: Parameters<typeof remoteImageModelChoices>[0]['slot'], file: RemoteImageModelEditor['components'][number]['file'] | undefined }): ImageModelChoice[] {
    const choices = remoteImageModelChoices({ catalog: catalog.value, slot, family: editor.value.primary?.family });
    if (file) {
      const id = remoteImageFileKey({ file });
      if (!choices.some(item => item.id === id)) choices.unshift({ id, label: file.location.path, detail: file.location.path, evidence: [], status: 'unverified', issue: undefined });
    }
    return choices;
  }
  const primaryChoices = computed(() => choices({ slot: 'primary', file: editor.value.primary?.file }));
  const primaryKey = computed(() => editor.value.primary ? remoteImageFileKey({ file: editor.value.primary.file }) : '');
  const components = computed<(ImageComponentChoice & { slot: RemoteImageModelEditor['components'][number]['slot'] })[]>(() => {
    const requirements = componentRequirements({ family: knownImageFamily({ family: editor.value.primary?.family }) });
    // Optional slots stay editable too; a provider's family description never
    // grants permission or silently fills a missing model component.
    return (['vae', 'clipL', 'clipG', 't5', 'lm'] as const).map(slot => {
      const file = editor.value.components.find(item => item.slot === slot)?.file;
      return { slot, selected: file ? remoteImageFileKey({ file }) : '', required: requirements.some(item => item.slot === slot && item.required), choices: choices({ slot, file }) };
    });
  });
  const loraChoices = computed(() => choices({ slot: 'lora', file: undefined }));
  function choosePrimary({ id }: { id: string }): void {
    if (blocked()) return;
    if (!id) {
      setEditor({ value: emptyRemoteImageModelEditor() }); return;
    }
    const item = catalog.value.find(item => remoteImageFileKey({ file: item.file }) === id);
    if (!item || !primaryChoices.value.some(choice => choice.id === id)) return;
    if (item.selection) {
      selectModel({ value: item.selection }); return;
    }
    const slot = item.roles.includes('model') ? 'model' : 'diffusion';
    setEditor({ value: { primary: { slot, file: item.file, family: item.facts?.family }, components: [], loras: [] } });
  }
  function chooseComponent({ slot, id }: { slot: RemoteImageModelEditor['components'][number]['slot'], id: string }): void {
    if (blocked()) return;
    const item = id ? catalog.value.find(item => remoteImageFileKey({ file: item.file }) === id) : undefined;
    if (id && (!item || !components.value.find(component => component.slot === slot)?.choices.some(choice => choice.id === id))) return;
    setEditor({ value: { ...editor.value, components: [...editor.value.components.filter(component => component.slot !== slot), ...(item ? [{ slot, file: item.file }] : [])] } });
  }
  function addLora({ id }: { id: string }): void {
    if (blocked() || editor.value.loras.length >= 8) return;
    const item = catalog.value.find(item => remoteImageFileKey({ file: item.file }) === id && item.roles.includes('lora'));
    if (item) setEditor({ value: { ...editor.value, loras: [...editor.value.loras, { file: item.file, strength: 1, enabled: 'enabled' }] } });
  }
  function changeLora({ index, strength, enabled }: { index: number, strength: number, enabled: 'enabled' | 'disabled' }): void {
    if (blocked()) return;
    setEditor({ value: { ...editor.value, loras: editor.value.loras.map((item, position) => position === index ? { ...item, strength, enabled } : item) } });
  }
  function removeLora({ index }: { index: number }): void {
    if (!blocked()) setEditor({ value: { ...editor.value, loras: editor.value.loras.filter((_item, position) => position !== index) } });
  }
  function capturePreferences(): { inferenceLocation: ImageInferenceLocationPreference, remoteModelEditors: RemoteImageModelEditorPreference[] } {
    const durable = ({ id, peer }: { id: NaidanRpcRegistrationId, peer: NaidanRpcPeerPublicKey }): boolean => {
      const entry = entries.value.find(item => item.registration.id === id && item.registration.peerPublicKey === peer);
      return entry ? entry.persistence === 'saved' && entry.registryPersistence === 'durable' : durableReferences.has(`${idToRaw({ id })}:${idToRaw({ id: peer })}`);
    };
    const registration = registrationId.value && peerPublicKey.value && durable({ id: registrationId.value, peer: peerPublicKey.value })
      ? { registrationId: registrationId.value, peerPublicKey: peerPublicKey.value } : undefined;
    const location = (() => {
      switch (kind.value) {
      case 'local': return { kind: 'local' as const };
      case 'naidan_rpc': return unavailable.value ? { kind: 'unavailable' as const } : { kind: 'naidan_rpc' as const, registration };
      default: { const exhaustive: never = kind.value; throw new Error(String(exhaustive)); }
      }
    })();
    const active = new Map(editors.value.filter(item => durable({ id: item.registrationId, peer: item.peerPublicKey }))
      .map(item => [`${idToRaw({ id: item.registrationId })}:${idToRaw({ id: item.peerPublicKey })}`, { ...item, editor: copyRemoteImageModelEditor({ editor: item.editor }) }]));
    return { inferenceLocation: location, remoteModelEditors: [...active.values()] };
  }
  function restorePreferences({ inferenceLocation, remoteModelEditors }: {
    inferenceLocation: ImageInferenceLocationPreference | undefined, remoteModelEditors: readonly RemoteImageModelEditorPreference[] | undefined,
  }): void {
    editors.value = (remoteModelEditors ?? []).map(item => ({ ...item, editor: copyRemoteImageModelEditor({ editor: item.editor }) }));
    durableReferences.clear();
    for (const item of editors.value) durableReferences.add(`${idToRaw({ id: item.registrationId })}:${idToRaw({ id: item.peerPublicKey })}`);
    discardCatalog();
    const location = inferenceLocation ?? { kind: 'local' as const };
    const modelEditor = (() => {
      switch (location.kind) {
      case 'local': case 'unavailable': return undefined;
      case 'naidan_rpc':
        if (location.registration) durableReferences.add(`${idToRaw({ id: location.registration.registrationId })}:${idToRaw({ id: location.registration.peerPublicKey })}`);
        return editors.value.find(item => item.registrationId === location.registration?.registrationId && item.peerPublicKey === location.registration?.peerPublicKey)?.editor;
      default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
      }
    })();
    restoreLocation({ location, modelEditor });
  }
  function captureLocation(): ImageInferenceLocationPreference {
    switch (kind.value) {
    case 'local': return { kind: 'local' };
    case 'naidan_rpc': return unavailable.value ? { kind: 'unavailable' } : { kind: 'naidan_rpc', registration: registrationId.value && peerPublicKey.value ? { registrationId: registrationId.value, peerPublicKey: peerPublicKey.value } : undefined };
    default: { const exhaustive: never = kind.value; throw new Error(String(exhaustive)); }
    }
  }
  function restoreLocation({ location, modelEditor }: { location: ImageInferenceLocationPreference, modelEditor: RemoteImageModelEditor | undefined }): void {
    discardCatalog();
    switch (location.kind) {
    case 'local': unavailable.value = false; kind.value = 'local'; break;
    case 'unavailable':
      unavailable.value = true; kind.value = 'naidan_rpc'; registrationId.value = undefined; peerPublicKey.value = undefined; label.value = '';
      setEditor({ value: emptyRemoteImageModelEditor() }); break;
    case 'naidan_rpc':
      unavailable.value = false;
      kind.value = 'naidan_rpc'; registrationId.value = location.registration?.registrationId; peerPublicKey.value = location.registration?.peerPublicKey; label.value = '';
      setEditor({ value: modelEditor ?? emptyRemoteImageModelEditor() }); break;
    default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
    }
  }
  function runtime(): ImageGenerationRemoteRuntime {
    if (!registrationId.value || !peerPublicKey.value) throw new Error('Choose a Naidan RPC registration first');
    return {
      profile: 'naidan-rpc',
      registrationId: registrationId.value,
      peerPublicKey: peerPublicKey.value,
      label: label.value,
      modelSelection: selection.value && imageModelSelectionSchema.parse(selection.value),
    };
  }
  function captureDraftRequest({ seed }: { seed: string }): { request: ImageGenerationDraftRequest, inputFiles: HistoryBinaryFile[] } {
    const inputFiles: HistoryBinaryFile[] = [];
    const image = ({ file }: { file: File }) => {
      const binaryObjectId = identifyInput({ file });
      if (!inputFiles.some(item => item.binaryObjectId === binaryObjectId)) inputFiles.push({ binaryObjectId, blob: file, name: file.name });
      return { binaryObjectId, name: file.name };
    };
    // Native-only options are deliberately absent: they are not remote settings
    // and this request must not claim that the provider applied local defaults.
    const { prompt, negativePrompt, width, height, steps, guidance, sampler, scheduler, distilledGuidance } = form.parameters.value;
    const inputs = form.imageInputs.value;
    return {
      inputFiles,
      request: {
        parameters: { prompt, negativePrompt, width, height, steps, guidance, seed, sampler, scheduler, distilledGuidance },
        preview: { ...form.preview.value },
        models: [],
        loras: [],
        runtime: isRemote.value && registrationId.value && peerPublicKey.value ? runtime() : undefined,
        imageInputs: {
          initImage: inputs.initImage && image({ file: inputs.initImage }),
          strength: inputs.strength,
          referenceImages: inputs.referenceImages.map(file => image({ file })),
        },
      },
    };
  }
  function snapshot({ seed, createdAt }: { seed: string, createdAt: number }): ImageGenerationSnapshot {
    const captured = captureDraftRequest({ seed });
    return copyImageGenerationSnapshot({
      snapshot: {
        id: generateId<ImageGenerationId>(),
        createdAt,
        inputFiles: captured.inputFiles,
        request: { ...captured.request, runtime: runtime() },
      },
    });
  }
  async function prepare({ seed, createdAt, signal }: { seed: string, createdAt: number, signal: AbortSignal }): Promise<PreparedImageExecution> {
    // Capture before awaiting the manager; edits belong to the next generation.
    const captured = snapshot({ seed, createdAt });
    const runtimeSnapshot = captured.request.runtime;
    if (runtimeSnapshot.profile !== 'naidan-rpc' || !runtimeSnapshot.modelSelection || !ready.value) throw new Error('Choose an explicit remote model configuration');
    const parameters = peerImageParametersSchema.parse(captured.request.parameters), preview = peerImagePreviewSchema.parse(captured.request.preview);
    const inputs = form.imageInputs.value;
    const input = {
      modelSelection: imageModelSelectionSchema.parse(runtimeSnapshot.modelSelection),
      parameters,
      preview,
      imageInputs: { initial: inputs.initImage, references: [...inputs.referenceImages], strength: inputs.strength },
    };
    const binding = (await getRpcManager()).bindClient({ id: runtimeSnapshot.registrationId });
    signal.throwIfAborted();
    if (binding.registration.peerPublicKey !== runtimeSnapshot.peerPublicKey) throw new Error('The saved model belongs to a different remote identity');
    const plan = preparePeerImageExecution({ binding, input });
    return {
      get snapshot() {
        return copyImageGenerationSnapshot({ snapshot: captured });
      },
      start: plan.start,
    };
  }
  function restore({ value, modelEditor }: { value: ImageGenerationRemoteRuntime, modelEditor: RemoteImageModelEditor | undefined }): void {
    discardCatalog(); unavailable.value = false; kind.value = 'naidan_rpc'; registrationId.value = value.registrationId; peerPublicKey.value = value.peerPublicKey;
    label.value = value.label;
    setEditor({ value: modelEditor ?? (value.modelSelection ? remoteImageEditorFromSelection({ selection: imageModelSelectionSchema.parse(value.modelSelection), family: undefined }) : emptyRemoteImageModelEditor()) });
    // Caller triggers this after local input restoration; it never reconnects.
  }
  function setKind({ value }: { value: 'local' | 'naidan_rpc' }): void {
    if (!blocked()) {
      unavailable.value = false; kind.value = value;
    }
  }
  return {
    setKind,
    kind,
    registrationId,
    peerPublicKey,
    label,
    selection,
    editor,
    ready,
    primaryChoices,
    primaryKey,
    components,
    loraChoices,
    entries,
    catalog,
    loading,
    failure,
    connected,
    refresh,
    chooseRegistration,
    loadModels,
    selectModel,
    snapshot,
    prepare,
    restore,
    choosePrimary,
    chooseComponent,
    addLora,
    changeLora,
    removeLora,
    capturePreferences,
    restorePreferences,
    captureLocation,
    restoreLocation,
    captureDraftRequest,
    registrationKey: computed(() => registrationId.value ? idToRaw({ id: registrationId.value }) : ''),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}
export type ImageInferenceLocationView = ReturnType<typeof useImageInferenceLocation>;
export const TEST_ONLY = {
};
