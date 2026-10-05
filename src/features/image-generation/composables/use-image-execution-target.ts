import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { generateId } from '@/01-models/id';
import { idToRaw, type BinaryObjectId, type NaidanRpcConnectionId, type NaidanRpcPeerId, type ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRemoteRuntime } from '@/01-models/image-generation-history';
import type { createImageForm } from '@/features/image-generation/form';
import type { ImageGenerationSnapshot, HistoryBinaryFile } from '@/features/image-generation/history/snapshot';
import { copyImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import type { PreparedImageExecution } from '@/features/image-generation/execution/types';
import { imageModelSelectionSchema, peerImageParametersSchema, peerImagePreviewSchema } from '@/features/naidan-peer-rpc/contract';
import type { PeerImageCatalogItem, PeerImageModelSelection } from '@/features/naidan-peer-rpc/contract';
import { preparePeerImageExecution } from '@/features/naidan-peer-rpc/adapters/image-execution';
import { getRpcManager, subscribeRpcState } from '@/features/naidan-peer-rpc/runtime/feature';
import type { RpcConnectionView } from '@/features/naidan-peer-rpc/runtime/manager';

/** Selection is draft state. Neither selection, restore nor refresh connects a
 * peer. Model references are always scoped to a verified remote identity. */
export function useImageExecutionTarget({ form, blocked, identifyInput }: {
  form: ReturnType<typeof createImageForm>, blocked(): boolean,
  identifyInput({ file }: { file: File }): BinaryObjectId,
}) {
  const kind = ref<'local' | 'naidan_rpc'>('local');
  const isRemote = computed(() => {
    switch (kind.value) {
    case 'local': return false;
    case 'naidan_rpc': return true;
    default: { const exhaustive: never = kind.value; throw new Error(String(exhaustive)); }
    }
  });
  const connectionId = ref<NaidanRpcConnectionId>();
  const peerId = ref<NaidanRpcPeerId>();
  const label = ref('');
  const selection = shallowRef<PeerImageModelSelection>();
  const entries = shallowRef<RpcConnectionView[]>([]);
  const catalog = shallowRef<PeerImageCatalogItem[]>([]);
  const loading = ref(false), failure = ref('');
  let disposed = false, catalogEpoch = 0, refreshEpoch = 0;
  let catalogStop: AbortController | undefined;
  const selected = computed(() => entries.value.find(item => item.connection.id === connectionId.value));
  const connected = computed(() => selected.value?.phase === 'connected' && selected.value.connection.peerId === peerId.value);
  const unsubscribe = subscribeRpcState({ listener() {
    if (isRemote.value) void refresh({ fromStorage: false });
  } });
  onScopeDispose(() => {
    disposed = true; catalogStop?.abort(); unsubscribe();
  });
  function discardCatalog(): void {
    catalogEpoch++; catalogStop?.abort(); catalogStop = undefined; catalog.value = []; loading.value = false;
  }
  function chooseConnection({ id }: { id: NaidanRpcConnectionId | undefined }): void {
    if (blocked()) return;
    discardCatalog(); connectionId.value = id;
    const next = entries.value.find(item => item.connection.id === id);
    peerId.value = next?.connection.peerId; label.value = next?.connection.label ?? '';
    selection.value = undefined; failure.value = '';
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
    if (blocked() || !connectionId.value || !peerId.value || loading.value) return;
    discardCatalog(); const epoch = catalogEpoch, id = connectionId.value, expectedPeer = peerId.value;
    const stop = new AbortController(); catalogStop = stop; loading.value = true; failure.value = '';
    try {
      const binding = (await getRpcManager()).bindClient({ id });
      stop.signal.throwIfAborted();
      if (binding.connection.peerId !== expectedPeer) throw new Error('The selected peer identity changed');
      const call = binding.client.listImageModels({ input: {}, on: {}, signal: AbortSignal.any([stop.signal, binding.signal]), timeoutMs: undefined });
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
        if (!disposed && epoch === catalogEpoch) catalog.value = items;
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
    selection.value = imageModelSelectionSchema.parse(value);
  }
  function runtime(): ImageGenerationRemoteRuntime {
    if (!connectionId.value || !peerId.value) throw new Error('Choose a registered Naidan RPC connection first');
    return { profile: 'naidan-rpc', connectionId: connectionId.value, peerId: peerId.value, label: label.value,
      modelSelection: selection.value && imageModelSelectionSchema.parse(selection.value) };
  }
  function snapshot({ seed, createdAt }: { seed: string, createdAt: number }): ImageGenerationSnapshot {
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
    return copyImageGenerationSnapshot({ snapshot: { id: generateId<ImageGenerationId>(), createdAt, inputFiles,
      request: { parameters: { prompt, negativePrompt, width, height, steps, guidance, seed, sampler, scheduler, distilledGuidance },
        preview: { ...form.preview.value }, models: [], loras: [], runtime: runtime(),
        imageInputs: { initImage: inputs.initImage && image({ file: inputs.initImage }), strength: inputs.strength,
          referenceImages: inputs.referenceImages.map(file => image({ file })) } } } });
  }
  async function prepare({ seed, createdAt, signal }: { seed: string, createdAt: number, signal: AbortSignal }): Promise<PreparedImageExecution> {
    // Capture before awaiting the manager; edits belong to the next generation.
    const captured = snapshot({ seed, createdAt });
    const target = captured.request.runtime;
    if (target.profile !== 'naidan-rpc' || !target.modelSelection) throw new Error('Choose an explicit remote model configuration');
    const parameters = peerImageParametersSchema.parse(captured.request.parameters), preview = peerImagePreviewSchema.parse(captured.request.preview);
    const inputs = form.imageInputs.value;
    const input = { modelSelection: imageModelSelectionSchema.parse(target.modelSelection), parameters, preview,
      imageInputs: { initial: inputs.initImage, references: [...inputs.referenceImages], strength: inputs.strength } };
    const binding = (await getRpcManager()).bindClient({ id: target.connectionId });
    signal.throwIfAborted();
    if (binding.connection.peerId !== target.peerId) throw new Error('The saved model belongs to a different remote identity');
    const plan = preparePeerImageExecution({ binding, input });
    return { get snapshot() {
      return copyImageGenerationSnapshot({ snapshot: captured });
    }, start: plan.start };
  }
  function restore({ value }: { value: ImageGenerationRemoteRuntime }): void {
    discardCatalog(); kind.value = 'naidan_rpc'; connectionId.value = value.connectionId; peerId.value = value.peerId;
    label.value = value.label; selection.value = value.modelSelection && imageModelSelectionSchema.parse(value.modelSelection);
    // Caller triggers this after local input restoration; it never reconnects.
  }
  function setKind({ value }: { value: 'local' | 'naidan_rpc' }): void {
    if (!blocked()) kind.value = value;
  }
  return { setKind, kind, connectionId, peerId, label, selection, entries, catalog, loading, failure, connected,
    refresh, chooseConnection, loadModels, selectModel, snapshot, prepare, restore,
    connectionKey: computed(() => connectionId.value ? idToRaw({ id: connectionId.value }) : ''),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}), };
}
export type ImageExecutionTargetView = ReturnType<typeof useImageExecutionTarget>;
export const TEST_ONLY = {
};
