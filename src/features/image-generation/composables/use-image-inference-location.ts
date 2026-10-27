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
import { imageCatalogItemSchema, imageModelSelectionSchema, peerImageParametersSchema, peerImagePreviewSchema } from '@/features/naidan-rpc-integration/contract';
import type { PeerImageCatalogItem } from '@/features/naidan-rpc-integration/contract';
import { preparePeerImageExecution } from '@/features/naidan-rpc-integration/adapters/image-execution';
import { getRpcManager, subscribeRpcState } from '@/features/naidan-rpc-integration/runtime/feature';
import type { RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import { copyRemoteImageModelEditor, emptyRemoteImageModelEditor, remoteImageEditorFromSelection, remoteImageEditorReady, remoteImageFileKey, remoteImageModelChoices, remoteImageSelectionFromEditor } from '@/features/image-generation/remote-image-model-editor';
import { componentRequirements, knownImageFamily } from '@/features/image-generation/model-configuration';
import type { ImageComponentChoice, ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
import type { ImageModelFacts } from '@/features/stable-diffusion-cpp-browser/recommendations';
import { chooseInitialImagePrimary, imagePrimarySlot, type ImageComponentSlot } from '@/features/image-generation/model-selection';
import { reconcileRemoteImageEditor, remoteImageEditorMatchesCatalog, remoteImageFileMatches, remoteImagePrimaryItem, remoteImageSelectionCandidates } from '@/features/image-generation/remote-image-model-selection';
import { imageSelectionParameters } from '@/features/image-generation/selection-parameters';
import { emptyImageInputs } from '@/features/image-generation/image-input-form';

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
    default: {
      const exhaustive: never = kind.value;
      throw new Error(String(exhaustive));
    }
    }
  });
  const registrationId = ref<NaidanRpcRegistrationId>();
  const peerPublicKey = ref<NaidanRpcPeerPublicKey>();
  const label = ref('');
  const editor = shallowRef<RemoteImageModelEditor>(emptyRemoteImageModelEditor());
  const editors = shallowRef<RemoteImageModelEditorPreference[]>([]);
  const durableReferences = new Set<string>();
  const selection = computed(() => remoteImageSelectionFromEditor({ editor: editor.value }));
  const ready = computed(() => remoteImageEditorReady({ editor: editor.value })
    && (!editor.value.automaticSlots.length || catalogFresh.value && canAutomaticallySelect.value)
    && (!catalogFresh.value || remoteImageEditorMatchesCatalog({ editor: editor.value, catalog: catalog.value })));
  const entries = shallowRef<RpcRegistrationView[]>([]);
  const catalog = shallowRef<PeerImageCatalogItem[]>([]);
  const loading = ref(false), failure = ref(''), saveFailure = ref('');
  const catalogFresh = ref(false);
  const catalogRevision = ref(0);
  const catalogActive = ref(false), catalogEnabled = ref(false);
  // The owner may construct its busy/history state after this composable.
  // Do not evaluate that state until the editor or an explicit request is active.
  const catalogBlocked = computed(() => (catalogActive.value || loading.value) && blocked());
  let activityKnown = false;
  let primaryOrigin: 'uninitialized' | 'automatic' | 'manual' | 'history' = 'uninitialized';
  const attemptedSessions = new WeakMap<object, Map<string, AbortController>>();
  let disconnectCatalog: (() => void) | undefined;
  const selectionCandidates = computed(() => remoteImageSelectionCandidates({ catalog: catalog.value }));
  const canAutomaticallySelect = computed(() => catalogFresh.value && selectionCandidates.value !== undefined);
  const catalogStale = computed(() => !catalogFresh.value && catalog.value.length > 0);
  const selectedFilesChanged = computed(() => catalogFresh.value && !!editor.value.primary && !remoteImageEditorMatchesCatalog({ editor: { ...editor.value, automaticSlots: [] }, catalog: catalog.value }));
  const selectedFacts = computed<ImageModelFacts | undefined>(() => {
    if (!catalogFresh.value) {
      return undefined;
    }
    const item = remoteImagePrimaryItem({ editor: editor.value, catalog: catalog.value });
    return item?.facts ? { family: knownImageFamily({ family: item.facts.family }), variant: item.facts.variant ?? 'unknown', evidence: item.facts.evidence ?? [] } : undefined;
  });
  let disposed = false, catalogEpoch = 0, refreshEpoch = 0;
  let catalogStop: AbortController | undefined;
  const selected = computed(() => entries.value.find(item => item.registration.id === registrationId.value));
  const connected = computed(() => selected.value?.phase === 'connected' && selected.value.registration.peerPublicKey === peerPublicKey.value);
  const connectionToken = computed(() => connected.value ? selected.value?.connectionToken : undefined);
  const unsubscribe = subscribeRpcState({
    listener() {
      if (isRemote.value) {
        void refresh({ fromStorage: false });
      }
    },
  });
  onScopeDispose(() => {
    disposed = true;
    catalogStop?.abort();
    disconnectCatalog?.();
    unsubscribe();
  });
  function discardCatalog({ retry }: { retry: boolean }): void {
    if (retry && connectionToken.value) {
      attemptedSessions.get(connectionToken.value)?.delete(JSON.stringify([registrationId.value, peerPublicKey.value]));
    }
    catalogRevision.value++;
    catalogEpoch++;
    catalogStop?.abort();
    catalogStop = undefined;
    disconnectCatalog?.();
    disconnectCatalog = undefined;
    catalog.value = [];
    catalogFresh.value = false;
    loading.value = false;
  }
  function setCatalogActivity({ active, enabled }: { active: boolean, enabled: boolean }): void {
    activityKnown = true;
    catalogActive.value = active;
    catalogEnabled.value = enabled;
  }
  function hydrateEditor({ value, origin }: { value: RemoteImageModelEditor | undefined, origin: 'manual' | 'history' }): void {
    primaryOrigin = value ? origin : 'uninitialized';
    editor.value = value ? copyRemoteImageModelEditor({ editor: value }) : emptyRemoteImageModelEditor();
    saveFailure.value = '';
  }
  function chooseRegistration({ id }: { id: NaidanRpcRegistrationId | undefined }): void {
    if (blocked()) {
      return;
    }
    if (registrationId.value === id && selected.value?.registration.peerPublicKey === peerPublicKey.value) {
      return;
    }
    discardCatalog({ retry: false });
    if (isRemote.value) {
      form.imageInputs.value = emptyImageInputs();
    }
    unavailable.value = false;
    registrationId.value = id;
    const next = entries.value.find(item => item.registration.id === id);
    peerPublicKey.value = next?.registration.peerPublicKey;
    label.value = next?.registration.label ?? '';
    const saved = editors.value.find(item => item.registrationId === id && item.peerPublicKey === peerPublicKey.value);
    hydrateEditor({ value: saved?.editor, origin: 'manual' });
    discardCatalog({ retry: true });
    failure.value = '';
  }
  async function refresh({ fromStorage }: { fromStorage: boolean }): Promise<void> {
    const epoch = ++refreshEpoch;
    try {
      const manager = await getRpcManager();
      if (fromStorage) {
        await manager.reload();
      }
      if (!disposed && epoch === refreshEpoch) {
        entries.value = manager.list();
      }
    } catch (error) {
      if (!disposed && epoch === refreshEpoch) {
        entries.value = [];
        failure.value = error instanceof Error ? error.message : String(error);
      }
    }
  }
  watch(kind, () => {
    discardCatalog({ retry: true });
    if (isRemote.value) {
      void refresh({ fromStorage: true });
    }
  }, { flush: 'sync' });
  // Session/identity invalidation is synchronous. A queued registry refresh
  // cannot let an old stream publish into a newly selected peer.
  watch([registrationId, peerPublicKey, connected, connectionToken], () => discardCatalog({ retry: false }), { flush: 'sync' });
  watch([catalogActive, catalogEnabled, catalogBlocked], () => {
    if (!catalogActive.value || !catalogEnabled.value || blocked()) {
      catalogStop?.abort();
    }
  }, { flush: 'sync' });
  watch([kind, registrationId, peerPublicKey, connected, connectionToken, catalogActive, catalogEnabled, catalogBlocked, loading, catalogRevision], () => {
    const token = connectionToken.value;
    if (disposed || !isRemote.value || !catalogActive.value || !catalogEnabled.value || blocked() || loading.value || !connected.value || !token) {
      return;
    }
    const key = JSON.stringify([registrationId.value, peerPublicKey.value]);
    if (!attemptedSessions.get(token)?.has(key)) {
      void loadModels();
    }
  }, { flush: 'post' });

  async function loadModels(): Promise<void> {
    if (blocked() || !registrationId.value || !peerPublicKey.value || loading.value || !connected.value || activityKnown && !catalogEnabled.value) {
      return;
    }
    const epoch = ++catalogEpoch, id = registrationId.value, expectedPeer = peerPublicKey.value, token = connectionToken.value;
    const attemptKey = JSON.stringify([id, expectedPeer]);
    const stop = new AbortController();
    if (token) {
      const attempts = attemptedSessions.get(token) ?? new Map<string, AbortController>();
      attempts.set(attemptKey, stop);
      attemptedSessions.set(token, attempts);
    }
    catalogStop?.abort();
    catalogStop = stop;
    // Preserve the last complete catalog for display while refreshing. It is
    // not fresh evidence for automatic selection until the stream closes.
    catalogFresh.value = false;
    loading.value = true;
    failure.value = '';
    try {
      const manager = await getRpcManager();
      stop.signal.throwIfAborted();
      const current = () => manager.list().find(item => item.registration.id === id && item.registration.peerPublicKey === expectedPeer);
      const entry = current();
      if (entry?.phase !== 'connected' || entry.connectionToken !== token) {
        throw new Error('The selected image catalog session changed');
      }
      const binding = manager.bindClient({ id });
      if (binding.registration.peerPublicKey !== expectedPeer || token !== undefined && binding.signal !== token) {
        throw new Error('The selected peer identity or session changed');
      }
      disconnectCatalog?.();
      const disconnected = () => discardCatalog({ retry: false });
      binding.signal.addEventListener('abort', disconnected, { once: true });
      disconnectCatalog = () => binding.signal.removeEventListener('abort', disconnected);
      const sessionSignal = AbortSignal.any([stop.signal, binding.signal]);
      sessionSignal.throwIfAborted();
      const call = binding.client.listImageModels({ input: {}, on: {}, signal: sessionSignal, timeoutMs: undefined });
      void call.closed.catch(() => {});
      let reader: ReadableStreamDefaultReader<PeerImageCatalogItem> | undefined;
      let cancelled = false, complete = false;
      const cancelCall = () => {
        if (!cancelled) {
          cancelled = true;
          call.cancel({ reason: 'Image catalog stopped' });
        }
        void reader?.cancel().catch(() => {});
      };
      sessionSignal.addEventListener('abort', cancelCall, { once: true });
      try {
        const stream = await call.result;
        sessionSignal.throwIfAborted();
        reader = stream.getReader();
        const items: PeerImageCatalogItem[] = [];
        for (;;) {
          const item = await reader.read();
          sessionSignal.throwIfAborted();
          if (item.done) {
            break;
          }
          if (items.length >= 256) {
            throw new Error('Remote image catalog exceeds its limit');
          }
          items.push(imageCatalogItemSchema.parse(item.value));
        }
        await call.closed;
        sessionSignal.throwIfAborted();
        const latest = current();
        if (!disposed && epoch === catalogEpoch && !blocked() && registrationId.value === id && peerPublicKey.value === expectedPeer
          && latest?.phase === 'connected' && latest.connectionToken === token) {
          if (new Set(items.map(item => remoteImageFileKey({ file: item.file }))).size !== items.length) {
            throw new Error('Duplicate remote image catalog file');
          }
          catalog.value = items;
          catalogFresh.value = true;
          reconcileCatalogSelection();
        }
        complete = true;
      } catch (error) {
        cancelCall();
        throw error;
      } finally {
        sessionSignal.removeEventListener('abort', cancelCall);
        if (!complete) {
          await reader?.cancel().catch(() => {});
        }
        reader?.releaseLock();
      }
    } catch (error) {
      if (!disposed && epoch === catalogEpoch && !stop.signal.aborted) {
        failure.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      // Visibility/busy cancellation may resume on reactivation; a genuine
      // failure is attempted only once per session until explicit refresh.
      if (stop.signal.aborted && token && attemptedSessions.get(token)?.get(attemptKey) === stop) {
        attemptedSessions.get(token)?.delete(attemptKey);
      }
      if (!disposed && epoch === catalogEpoch) {
        loading.value = false;
        catalogStop = undefined;
      }
    }
  }

  function primaryChanged({ item }: { item: PeerImageCatalogItem | undefined }): void {
    if (!isRemote.value) {
      return;
    }
    form.imageInputs.value = emptyImageInputs();
    if (item?.facts) {
      form.parameters.value = imageSelectionParameters({ parameters: form.parameters.value, family: knownImageFamily({ family: item.facts.family }), turbo: item.facts.variant === 'turbo', location: 'naidan_rpc' });
    }
  }
  function adoptPrimary({ item, origin }: { item: PeerImageCatalogItem | undefined, origin: 'manual' | 'automatic' }): void {
    primaryOrigin = origin;
    if (!item) {
      const hadPrimary = !!editor.value.primary;
      setEditor({ value: emptyRemoteImageModelEditor() });
      if (hadPrimary) {
        primaryChanged({ item: undefined });
      }
      return;
    }
    const family = knownImageFamily({ family: item.facts?.family });
    const slot = imagePrimarySlot({ family }) ?? (item.roles.includes('model') ? 'model' : 'diffusion');
    const legacy = !canAutomaticallySelect.value && item.selection && item.selection.primary.slot === slot
      && remoteImageFileMatches({ file: item.file, candidate: item.selection.primary.file })
      ? remoteImageEditorFromSelection({ selection: item.selection, family: item.facts?.family }) : undefined;
    const next: RemoteImageModelEditor = legacy ?? {
      primary: { slot, file: item.file, family: item.facts?.family },
      components: [],
      loras: [],
      automaticSlots: canAutomaticallySelect.value ? componentRequirements({ family }).map(requirement => requirement.slot) : [],
    };
    setEditor({ value: canAutomaticallySelect.value ? reconcileRemoteImageEditor({ editor: next, catalog: catalog.value }) : next });
    primaryChanged({ item });
  }
  function reconcileCatalogSelection(): void {
    if (!canAutomaticallySelect.value || blocked()) {
      return;
    }
    switch (primaryOrigin) {
    case 'uninitialized': case 'automatic': {
      // A same-path replacement is not a vanished primary. Keep its pinned
      // reference and require explicit reselection instead of resetting a draft.
      if (primaryOrigin === 'automatic' && editor.value.primary && catalog.value.some(item => remoteImageFileKey({ file: item.file }) === primaryKey.value)) {
        break;
      }
      const key = chooseInitialImagePrimary({ candidates: selectionCandidates.value! });
      if (key !== undefined || primaryOrigin === 'automatic') {
        adoptPrimary({ item: catalog.value.find(item => remoteImageFileKey({ file: item.file }) === key), origin: 'automatic' });
      }
      return;
    }
    case 'history': return;
    case 'manual': break;
    default: {
      const exhaustive: never = primaryOrigin;
      throw new Error(String(exhaustive));
    }
    }
    // Read the current intent after every await. Intervening manual edits win.
    const next = reconcileRemoteImageEditor({ editor: editor.value, catalog: catalog.value });
    if (JSON.stringify(next) !== JSON.stringify(editor.value)) {
      setEditor({ value: next });
    }
  }

  function selectModel({ value }: { value: unknown }): void {
    if (blocked()) {
      return;
    }
    const parsed = imageModelSelectionSchema.parse(value);
    const item = catalog.value.find(item => remoteImageFileKey({ file: item.file }) === remoteImageFileKey({ file: parsed.primary.file }));
    const changed = !editor.value.primary || !remoteImageFileMatches({ file: editor.value.primary.file, candidate: parsed.primary.file });
    primaryOrigin = 'manual';
    setEditor({ value: remoteImageEditorFromSelection({ selection: parsed, family: item?.facts?.family }) });
    if (changed) {
      primaryChanged({ item });
    }
  }
  function setEditor({ value }: { value: RemoteImageModelEditor }): void {
    const copied = copyRemoteImageModelEditor({ editor: value });
    const id = registrationId.value, peer = peerPublicKey.value;
    if (id && peer) {
      const previous = editors.value.find(item => item.registrationId === id && item.peerPublicKey === peer);
      if (!previous && editors.value.length >= 32) {
        // The live draft remains usable even when it cannot be remembered.
        saveFailure.value = 'Too many saved remote model editors';
      } else if (!previous || JSON.stringify(previous.editor) !== JSON.stringify(copied)) {
        editors.value = [...editors.value.filter(item => item !== previous), { registrationId: id, peerPublicKey: peer, editor: copied }];
        saveFailure.value = '';
      }
    }
    if (JSON.stringify(editor.value) !== JSON.stringify(copied)) {
      editor.value = copied;
    }
  }
  function choices({ slot, file }: { slot: Parameters<typeof remoteImageModelChoices>[0]['slot'], file: RemoteImageModelEditor['components'][number]['file'] | undefined }): ImageModelChoice[] {
    const choices = remoteImageModelChoices({ catalog: catalog.value, slot, family: editor.value.primary?.family });
    if (file) {
      const id = remoteImageFileKey({ file });
      if (!choices.some(item => item.candidateKey === id)) {
        choices.unshift({ candidateKey: id, label: file.location.path, detail: file.location.path, evidence: [], status: 'unverified', issue: undefined });
      }
    }
    return choices;
  }
  const primaryChoices = computed(() => choices({ slot: 'primary', file: editor.value.primary?.file }));
  const primaryKey = computed(() => editor.value.primary ? remoteImageFileKey({ file: editor.value.primary.file }) : '');
  const components = computed<(ImageComponentChoice & { slot: ImageComponentSlot, automatic: boolean, canSelectAutomatically: boolean })[]>(() => {
    const requirements = componentRequirements({ family: knownImageFamily({ family: editor.value.primary?.family }) });
    // Optional and unknown-family slots remain manually editable. Only a
    // recognized requirement with fresh evidence can opt into automation.
    return (['vae', 'clipL', 'clipG', 't5', 'lm'] as const).map(slot => {
      const file = editor.value.components.find(item => item.slot === slot)?.file;
      return { slot, selectedCandidateKey: file ? remoteImageFileKey({ file }) : '', required: requirements.some(item => item.slot === slot && item.required), choices: choices({ slot, file }), automatic: editor.value.automaticSlots.includes(slot), canSelectAutomatically: canAutomaticallySelect.value && requirements.some(item => item.slot === slot) && !!remoteImagePrimaryItem({ editor: editor.value, catalog: catalog.value }) };
    });
  });
  const loraChoices = computed(() => choices({ slot: 'lora', file: undefined }));
  function choosePrimary({ id }: { id: string }): void {
    if (blocked()) {
      return;
    }
    if (!id) {
      adoptPrimary({ item: undefined, origin: 'manual' });
      return;
    }
    const item = catalog.value.find(item => remoteImageFileKey({ file: item.file }) === id);
    if (!item || !primaryChoices.value.some(choice => choice.candidateKey === id)) {
      return;
    }
    if (primaryKey.value === id && remoteImagePrimaryItem({ editor: editor.value, catalog: [item] })) {
      primaryOrigin = 'manual';
      return;
    }
    adoptPrimary({ item, origin: 'manual' });
  }
  function setComponentAutomatic({ slot, automatic }: { slot: ImageComponentSlot, automatic: boolean }): void {
    if (blocked() || automatic && !components.value.find(component => component.slot === slot)?.canSelectAutomatically) {
      return;
    }
    const next = { ...editor.value, automaticSlots: [...editor.value.automaticSlots.filter(value => value !== slot), ...(automatic ? [slot] : [])] };
    setEditor({ value: automatic ? reconcileRemoteImageEditor({ editor: next, catalog: catalog.value }) : next });
  }
  function chooseComponent({ slot, id }: { slot: RemoteImageModelEditor['components'][number]['slot'], id: string }): void {
    if (blocked()) {
      return;
    }
    const item = id ? catalog.value.find(item => remoteImageFileKey({ file: item.file }) === id) : undefined;
    if (id && (!item || !components.value.find(component => component.slot === slot)?.choices.some(choice => choice.candidateKey === id))) {
      return;
    }
    setEditor({ value: { ...editor.value, automaticSlots: editor.value.automaticSlots.filter(value => value !== slot), components: [...editor.value.components.filter(component => component.slot !== slot), ...(item ? [{ slot, file: item.file }] : [])] } });
  }
  function addLora({ id }: { id: string }): void {
    if (blocked() || editor.value.loras.length >= 8) {
      return;
    }
    const item = catalog.value.find(item => remoteImageFileKey({ file: item.file }) === id && item.roles.includes('lora'));
    if (item) {
      setEditor({ value: { ...editor.value, loras: [...editor.value.loras, { file: item.file, strength: 1, enabled: 'enabled' }] } });
    }
  }
  function changeLora({ index, strength, enabled }: { index: number, strength: number, enabled: 'enabled' | 'disabled' }): void {
    if (blocked()) {
      return;
    }
    setEditor({ value: { ...editor.value, loras: editor.value.loras.map((item, position) => position === index ? { ...item, strength, enabled } : item) } });
  }
  function removeLora({ index }: { index: number }): void {
    if (!blocked()) {
      setEditor({ value: { ...editor.value, loras: editor.value.loras.filter((_item, position) => position !== index) } });
    }
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
      default: {
        const exhaustive: never = kind.value;
        throw new Error(String(exhaustive));
      }
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
    for (const item of editors.value) {
      durableReferences.add(`${idToRaw({ id: item.registrationId })}:${idToRaw({ id: item.peerPublicKey })}`);
    }
    discardCatalog({ retry: false });
    const location = inferenceLocation ?? { kind: 'local' as const };
    const modelEditor = (() => {
      switch (location.kind) {
      case 'local': case 'unavailable': return undefined;
      case 'naidan_rpc':
        if (location.registration) {
          durableReferences.add(`${idToRaw({ id: location.registration.registrationId })}:${idToRaw({ id: location.registration.peerPublicKey })}`);
        }
        return editors.value.find(item => item.registrationId === location.registration?.registrationId && item.peerPublicKey === location.registration?.peerPublicKey)?.editor;
      default: {
        const exhaustive: never = location;
        throw new Error(String(exhaustive));
      }
      }
    })();
    restoreLocation({ location, modelEditor });
  }
  function captureLocation(): ImageInferenceLocationPreference {
    switch (kind.value) {
    case 'local': return { kind: 'local' };
    case 'naidan_rpc': return unavailable.value ? { kind: 'unavailable' } : { kind: 'naidan_rpc', registration: registrationId.value && peerPublicKey.value ? { registrationId: registrationId.value, peerPublicKey: peerPublicKey.value } : undefined };
    default: {
      const exhaustive: never = kind.value;
      throw new Error(String(exhaustive));
    }
    }
  }
  function restoreLocation({ location, modelEditor }: { location: ImageInferenceLocationPreference, modelEditor: RemoteImageModelEditor | undefined }): void {
    discardCatalog({ retry: false });
    switch (location.kind) {
    case 'local': unavailable.value = false;
      kind.value = 'local';
      break;
    case 'unavailable':
      unavailable.value = true;
      kind.value = 'naidan_rpc';
      registrationId.value = undefined;
      peerPublicKey.value = undefined;
      label.value = '';
      hydrateEditor({ value: emptyRemoteImageModelEditor(), origin: 'manual' });
      break;
    case 'naidan_rpc':
      unavailable.value = false;
      kind.value = 'naidan_rpc';
      registrationId.value = location.registration?.registrationId;
      peerPublicKey.value = location.registration?.peerPublicKey;
      label.value = '';
      hydrateEditor({ value: modelEditor, origin: 'manual' });
      break;
    default: {
      const exhaustive: never = location;
      throw new Error(String(exhaustive));
    }
    }
    discardCatalog({ retry: true });
  }
  function runtime(): ImageGenerationRemoteRuntime {
    if (!registrationId.value || !peerPublicKey.value) {
      throw new Error('Choose a Naidan RPC registration first');
    }
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
      if (!inputFiles.some(item => item.binaryObjectId === binaryObjectId)) {
        inputFiles.push({ binaryObjectId, blob: file, name: file.name });
      }
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
    if (runtimeSnapshot.profile !== 'naidan-rpc' || !runtimeSnapshot.modelSelection || !ready.value) {
      throw new Error('Choose an explicit remote model configuration');
    }
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
    if (binding.registration.peerPublicKey !== runtimeSnapshot.peerPublicKey) {
      throw new Error('The saved model belongs to a different remote identity');
    }
    const plan = preparePeerImageExecution({ binding, input });
    return {
      get snapshot() {
        return copyImageGenerationSnapshot({ snapshot: captured });
      },
      start: plan.start,
    };
  }
  function restore({ value, modelEditor }: { value: ImageGenerationRemoteRuntime, modelEditor: RemoteImageModelEditor | undefined }): void {
    discardCatalog({ retry: false });
    unavailable.value = false;
    kind.value = 'naidan_rpc';
    registrationId.value = value.registrationId;
    peerPublicKey.value = value.peerPublicKey;
    label.value = value.label;
    const restored = modelEditor ?? (value.modelSelection ? remoteImageEditorFromSelection({ selection: imageModelSelectionSchema.parse(value.modelSelection), family: undefined }) : emptyRemoteImageModelEditor());
    hydrateEditor({ value: { ...restored, automaticSlots: [] }, origin: 'history' });
    // Caller triggers this after local input restoration; it never reconnects.
  }
  function setKind({ value }: { value: 'local' | 'naidan_rpc' }): void {
    if (!blocked()) {
      unavailable.value = false;
      kind.value = value;
    }
  }
  return {
    setKind,
    setCatalogActivity,
    setComponentAutomatic,
    catalogFresh,
    catalogStale,
    canAutomaticallySelect,
    selectedFilesChanged,
    selectedFacts,
    saveFailure,
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
