import { areEndpointsEqual } from '@/01-models/endpoint';
import { hasLocalRepositoryReferencePrefix } from '@/01-models/llama-cpp-browser-model-id';
import { idToRaw, type ChatId, type ChatGroupId } from '@/01-models/ids';
import type { Endpoint, ScopedTitleGeneration, SettingsTitleGeneration } from '@/01-models/types';
import type { IStorageProvider } from './interface';

export type LocalModelReferenceOwner = { kind: 'global' } | { kind: 'chat', id: ChatId } | { kind: 'chat_group', id: ChatGroupId };
export type SavedLocalModelReference = {
  sourceModelId: string, modelId: string, isCurrent(): boolean, isIdentityCurrent(): boolean, retain(): { release(): void }, withCurrentFiles({ operation }: { operation(): Promise<void> }): Promise<void>,
};
export type LocalModelPromotion = {
  owner: LocalModelReferenceOwner,
  changes: readonly { slot: 'model' | 'title_model', sourceModelId: string, modelId: string }[],
  isCurrent(): boolean,
};

/** Reconfirm slots already saved by a write whose acknowledgement was lost.
 * Live consumers still patch only the exact pending value they currently own. */
export function localModelPromotionChanges({ fields, endpoint, mappings }: {
  fields: { modelId?: string, titleGeneration?: ScopedTitleGeneration }, endpoint: Endpoint, mappings: ReadonlyMap<string, string>,
}): LocalModelPromotion['changes'] {
  const changes: LocalModelPromotion['changes'][number][] = [];
  const title = fields.titleGeneration;
  for (const [sourceModelId, modelId] of mappings) {
    if (endpoint.type === 'llama_cpp_browser' && fields.modelId === modelId) {
      changes.push({ slot: 'model', sourceModelId, modelId });
    }
    if (title !== undefined && title !== 'inherit' && title !== 'disabled' && title.model !== 'same_scope'
      && (title.endpoint === 'same_scope' ? endpoint : title.endpoint).type === 'llama_cpp_browser' && title.model.id === modelId) {
      changes.push({ slot: 'title_model', sourceModelId, modelId });
    }
  }
  return changes;
}

const aliases = new Map<string, SavedLocalModelReference>();
const observed = new WeakMap<IStorageProvider, Map<string, { owner: LocalModelReferenceOwner, modelIds: readonly string[] }>>();

/** Only live, captured copy results may normalize a pending reference. Nothing
 * is inferred from prefixes, persisted on disk, or reconstructed after reload. */
export function rememberSavedLocalModelReference({ reference }: { reference: SavedLocalModelReference }): void {
  if (!hasLocalRepositoryReferencePrefix({ modelId: reference.sourceModelId, storage: 'pending' }) || !hasLocalRepositoryReferencePrefix({ modelId: reference.modelId, storage: 'saved' })) {
    throw new Error('Invalid saved local model reference');
  }
  const previous = aliases.get(reference.sourceModelId);
  // A readable name is leased to one live File source. Retain its original
  // copy proof instead of wrapping it again on every late read/write retry.
  if (previous?.modelId === reference.modelId && previous.isCurrent()) {
    return;
  }
  aliases.set(reference.sourceModelId, reference);
}

export function pruneSavedLocalModelReferences(): void {
  for (const [sourceModelId, reference] of aliases) {
    if (!reference.isIdentityCurrent()) {
      aliases.delete(sourceModelId);
    }
  }
}

export function savedLocalModelReferences({ modelIds }: { modelIds: readonly string[] }): SavedLocalModelReference[] {
  return [...new Set(modelIds)].flatMap(modelId => {
    const reference = aliases.get(modelId);
    if (!reference) {
      return [];
    }
    if (!reference.isIdentityCurrent()) {
      aliases.delete(modelId);
      return [];
    }
    return reference.isCurrent() ? [reference] : [];
  });
}

function savedModelId({ modelId }: { modelId: string }): string {
  const reference = aliases.get(modelId);
  if (!reference) {
    return modelId;
  }
  if (!reference.isIdentityCurrent()) {
    aliases.delete(modelId);
    return modelId;
  }
  return reference.modelId;
}

/** Preserve endpoint/inheritance semantics while a proven File source is saved. */
export function sameLocalModelBinding({ left, right }: {
  left: { endpoint?: Endpoint, modelId?: string }, right: { endpoint?: Endpoint, modelId?: string },
}): boolean {
  if ((left.endpoint === undefined) !== (right.endpoint === undefined)
    || (left.endpoint !== undefined && right.endpoint !== undefined && !areEndpointsEqual({ left: left.endpoint, right: right.endpoint }))) {
    return false;
  }
  if (left.modelId === right.modelId) {
    return true;
  }
  return left.endpoint?.type === 'llama_cpp_browser' && right.endpoint?.type === 'llama_cpp_browser'
    && left.modelId !== undefined && right.modelId !== undefined
    && savedModelId({ modelId: left.modelId }) === savedModelId({ modelId: right.modelId });
}

export function localModelReferenceIds({ modelId, titleGeneration }: {
  modelId: string | undefined, titleGeneration: ScopedTitleGeneration | undefined,
}): string[] {
  const titleModelId = titleGeneration !== undefined && titleGeneration !== 'disabled' && titleGeneration !== 'inherit'
    && titleGeneration.model !== 'same_scope' ? titleGeneration.model.id : undefined;
  return [modelId, titleModelId].flatMap(id => {
    if (id === undefined) {
      return [];
    }
    if (hasLocalRepositoryReferencePrefix({ modelId: id, storage: 'pending' })) {
      return [id];
    }
    const reference = [...aliases.values()].find(reference => reference.modelId === id && reference.isCurrent());
    return reference ? [id] : [];
  });
}

/** Track accessed/selected owners rather than scanning every saved chat. */
export function observeLocalModelReferences({ provider, owner, modelIds }: {
  provider: IStorageProvider, owner: LocalModelReferenceOwner, modelIds: readonly string[],
}): void {
  let owners = observed.get(provider);
  if (!owners) {
    owners = new Map();
    observed.set(provider, owners);
  }
  const key = (() => {
    switch (owner.kind) {
    case 'global': return 'global';
    case 'chat': case 'chat_group': return `${owner.kind}:${idToRaw({ id: owner.id })}`;
    default: {
      const exhaustive: never = owner;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (modelIds.length) {
    owners.set(key, { owner, modelIds: [...modelIds] });
  } else {
    owners.delete(key);
  }
}

export function observedLocalModelReferenceOwners({ provider, sourceModelIds }: { provider: IStorageProvider, sourceModelIds: readonly string[] }): LocalModelReferenceOwner[] {
  const sources = new Set(sourceModelIds.flatMap(sourceModelId => {
    const saved = aliases.get(sourceModelId);
    return saved?.isCurrent() ? [sourceModelId, saved.modelId] : [sourceModelId];
  }));
  return [...(observed.get(provider)?.values() ?? [])].filter(entry => entry.modelIds.some(modelId => sources.has(modelId))).map(entry => entry.owner);
}

export function promoteLocalModelId({ endpoint, modelId, mappings }: {
  endpoint: Endpoint, modelId: string | undefined, mappings: ReadonlyMap<string, string>,
}): string | undefined {
  return endpoint.type === 'llama_cpp_browser' && modelId !== undefined ? mappings.get(modelId) ?? modelId : modelId;
}

export function promoteLocalTitleModel({ titleGeneration, endpoint, mappings }: {
  titleGeneration: SettingsTitleGeneration, endpoint: Endpoint, mappings: ReadonlyMap<string, string>,
}): SettingsTitleGeneration {
  if (titleGeneration === 'disabled' || titleGeneration.model === 'same_scope') {
    return titleGeneration;
  }
  const modelId = promoteLocalModelId({ endpoint: titleGeneration.endpoint === 'same_scope' ? endpoint : titleGeneration.endpoint, modelId: titleGeneration.model.id, mappings });
  return modelId === titleGeneration.model.id || modelId === undefined ? titleGeneration : { ...titleGeneration, model: { ...titleGeneration.model, id: modelId } };
}

export function promoteScopedLocalTitleModel({ titleGeneration, endpoint, mappings }: {
  titleGeneration: ScopedTitleGeneration | undefined, endpoint: Endpoint, mappings: ReadonlyMap<string, string>,
}): ScopedTitleGeneration | undefined {
  return titleGeneration === undefined || titleGeneration === 'inherit' ? titleGeneration : promoteLocalTitleModel({ titleGeneration, endpoint, mappings });
}

export const TEST_ONLY = {
  referenceCount() {
    return aliases.size;
  },
  reset() {
    aliases.clear();
  },
};
