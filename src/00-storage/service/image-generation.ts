import { opfsFormat } from '@/00-format/01-layout/layout';
import { requireImageGenerationOperationMembership } from './image-generation/operations';
import { applyImageGenerationActivity, finishImageGenerationActivity, recoverImageGenerationActivities, reserveImageGenerationActivity } from './image-generation/activity';
import { compareImageGenerationSessions } from '@/01-models/image-generation';
import { assertImageGenerationBinariesNotDeleted } from './image-generation/deletions';
import type { ImageGenerationSessionDraft } from '@/01-models/image-generation';
import { z } from 'zod';
import { idToRaw, type ImageGenerationAssetId, type ImageGenerationRunId, type ImageGenerationSessionId, type NaidanId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { canTransitionImageGenerationRun, type ImageGenerationAsset, type ImageGenerationAssetAnnotations, type ImageGenerationAssetSummary, type ImageGenerationCatalog, type ImageGenerationReadResult, type ImageGenerationRun, type ImageGenerationRunExecution, type ImageGenerationRunSummary, type ImageGenerationSession, type ImageGenerationTagReference } from '@/01-models/image-generation';
import { validateImageGenerationId } from '@/00-format/image-generation-record';
import { imageGenerationExecutionForStorage, imageGenerationTagsForStorage } from '@/00-format/image-generation-workspace';
import { assertImageGenerationReplacement, imageGenerationRootIo, openImageGenerationCatalog, withImageGenerationStore, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationIo, imageGenerationIsNotFound } from './image-generation/files';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory, imageGenerationSessionTable } from './image-generation/tables';

export type { ImageGenerationStoreAccess } from './image-generation/context';

/** DTO strings are not path capabilities. Check the identities this operation
 * will use as path components before locking/opening storage or publishing bytes.
 * Display text and other metadata deliberately keep their relaxed DTO contract. */
function assertImageGenerationPathIds({ ids }: { ids: readonly NaidanId[] }): void {
  for (const id of ids) {
    validateImageGenerationId({ id });
  }
}


/** No directory is created during an ordinary read-only visit. */
export async function openImageGenerationStore({ storageType, creation }: { storageType: StorageType, creation: 'allow' | 'forbid' }): Promise<ImageGenerationCatalog | undefined> {
  return openImageGenerationCatalog({ storageType, creation });
}

export async function loadImageGenerationCatalog({ store }: { store: ImageGenerationStoreAccess }): Promise<ImageGenerationCatalog> {
  return withImageGenerationStore({ store, operation: async ({ catalog }) => catalog.value });
}

/** Rename/archive tags by stable ID. Definitions are never physically removed. */
export async function saveImageGenerationCatalog({ store, catalog, expectedRevision }: { store: ImageGenerationStoreAccess, catalog: ImageGenerationCatalog, expectedRevision: number }): Promise<void> {
  const catalogWrite = opfsFormat.storage.experimental.imageGeneration.catalog.prepareWrite({ value: catalog });
  const next = catalogWrite.snapshot.value;
  await withImageGenerationStore({
    store,
    operation: async ({ directory, catalog: snapshot }) => {
      const current = snapshot.value;
      if (next.id !== current.id || next.createdAt !== current.createdAt) {
        throw new Error('Image Generation catalog identity is immutable.');
      }
      for (const previous of current.tags) {
        const tag = next.tags.find(tag => tag.id === previous.id);
        if (!tag) {
          throw new Error('Archive tags instead of removing definitions referenced by images.');
        }
        if (tag.createdAt !== previous.createdAt) {
          throw new Error('Tag creation time is immutable.');
        }
      }
      assertImageGenerationReplacement({ current: snapshot, next: catalogWrite.snapshot, expectedRevision });
      if (!snapshot.matches({ other: catalogWrite.snapshot })) {
        await catalogWrite.write({ io: imageGenerationRootIo({ directory }) });
      }
    },
  });
}

export async function listImageGenerationSessions({ store }: { store: ImageGenerationStoreAccess }): Promise<ImageGenerationReadResult<ImageGenerationSession>> {
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const recovery = await recoverImageGenerationActivities({ directory });
      const result = await (await imageGenerationSessionTable({ directory, create: false })).list();
      return {
        warnings: [...recovery.warnings, ...result.warnings].slice(0, 100),
        warningCount: recovery.warningCount + result.warningCount,
        items: result.items.filter(session => session.state !== 'deleted').sort((a, b) => compareImageGenerationSessions({ a, b })),
      };
    },
  });
}

export async function loadImageGenerationSession({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationSession | undefined> {
  const id = validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await (await imageGenerationSessionTable({ directory, create: false })).load({ id });
      return session && session.state !== 'deleted' && session.state !== 'deleting' ? session : undefined;
    },
  });
}

export async function saveImageGenerationSession({ store, session, expectedRevision }: { store: ImageGenerationStoreAccess, session: ImageGenerationSession, expectedRevision: number | undefined }): Promise<ImageGenerationSession> {
  // Validate retained leaves before creating directories or reserving activity.
  const requested = opfsFormat.storage.experimental.imageGeneration.sessions.prepareWrite({ value: session }).snapshot.value;
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      if (requested.state === 'deleted' || requested.state === 'deleting') {
        throw new Error('Use the explicit session deletion operation.');
      }
      const table = await imageGenerationSessionTable({ directory, create: true });
      const snapshot = await table.read({ id: requested.id });
      const current = snapshot?.value;
      if (current?.state === 'deleted' || current?.state === 'deleting') {
        throw new Error('The session has been deleted.');
      }
      if (current && requested.createdAt !== current.createdAt) {
        throw new Error('Session creation time is immutable.');
      }
      // Callers cannot manufacture order, and retrying an acknowledged-lost save
      // must repair its index without reserving a newer position.
      const candidate = table.prepareWrite({ value: { ...requested, activityOrder: current?.activityOrder } });
      assertImageGenerationReplacement({ current: snapshot, next: candidate.snapshot, expectedRevision });
      await table.preflightWrite({ id: requested.id });
      const prepared = snapshot?.matches({ other: candidate.snapshot }) ? candidate
        : table.prepareWrite({ value: { ...candidate.snapshot.value, activityOrder: await reserveImageGenerationActivity({ directory, run: undefined }) } });
      await prepared.write({ assertCurrent: ({ current, next }) => assertImageGenerationReplacement({ current, next, expectedRevision }), async beforeCommit() {} });
      return prepared.snapshot.value;
    },
  });
}

/** Merge an accepted run's durable order into current metadata. The underlying
 * journal also replays during session listing after page reload or tab exit. */
export async function recordImageGenerationSessionUse({ store, sessionId, runId }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId,
}): Promise<ImageGenerationSession> {
  const id = validateImageGenerationId({ id: sessionId });
  const runKey = validateImageGenerationId({ id: runId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const result = await applyImageGenerationActivity({ directory, sessionId: id, runId: runKey });
      if (!result) {
        throw new Error('The generation is not accepted or its session has been deleted.');
      }
      return result;
    },
  });
}

/** Delete only session metadata. Stable BinaryObjects may be shared by chats and
 * intentionally survive. Keep a minimal tombstone so stale writers cannot revive
 * the session; cleanup can be retried after any interrupted directory removal. */
export async function deleteImageGenerationSession({ store, sessionId, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, expectedRevision: number,
}): Promise<void> {
  const id = validateImageGenerationId({ id: sessionId });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const table = await imageGenerationSessionTable({ directory, create: false });
      const snapshot = await table.read({ id });
      if (!snapshot) {
        throw new Error('The session no longer exists.');
      }
      const current = snapshot.value;
      let revision = current.revision;
      let clearAssociations = false;
      switch (current.state) {
      case 'deleted': return;
      case 'deleting': break;
      case 'active': case 'archived': {
        if (current.revision !== expectedRevision) {
          throw new Error('Image Generation revision conflict. Reload before deleting.');
        }
        const prepared = snapshot.prepareChanges({
          changes: {
            revision: current.revision + 1,
            updatedAt: Date.now(),
            state: 'deleting',
          },
        });
        await prepared.write({ assertCurrent: ({ current, next }) => assertImageGenerationReplacement({ current, next, expectedRevision }), async beforeCommit() {} });
        revision++;
        clearAssociations = true;
        break;
      }
      default: {
        const exhaustive: never = current.state;
        throw new Error(String(exhaustive));
      }
      }
      // Open the directory directly: ordinary readers intentionally reject tombstones.
      const location = await imageGenerationSessionDirectory({ directory, sessionId: id, requireLive: false });
      if (!location) {
        throw new DOMException('Image Generation session directory is missing.', 'NotFoundError');
      }
      const session = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id }) });
      const io = imageGenerationIo({ directory: location, path: session.path });
      for (const child of await session.removableChildren({ io })) {
        try {
          await io.remove({ location: child, recursive: true });
        } catch (error) {
          if (!imageGenerationIsNotFound({ error })) {
            throw error;
          }
        }
      }
      const deleted = snapshot.prepareChanges({
        changes: {
          revision: revision + 1,
          updatedAt: Date.now(),
          state: 'deleted',
          title: 'Deleted session',
          clearAssociations,
        },
      });
      await deleted.write({ assertCurrent: ({ current, next }) => assertImageGenerationReplacement({ current, next, expectedRevision: revision }), async beforeCommit() {} });
    },
  });
}

async function requireSession({ directory, sessionId }: { directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId }): Promise<FileSystemDirectoryHandle> {
  const session = await imageGenerationSessionDirectory({ directory, sessionId });
  if (!session) {
    throw new Error('Image Generation session does not exist.');
  }
  return session;
}

export async function loadImageGenerationDraft({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationSessionDraft | undefined> {
  const id = validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: id });
      const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id }) });
      return (await definition.draft.read({ io: imageGenerationIo({ directory: session, path: definition.path }) }))?.value;
    },
  });
}

/** A checkpoint may fail validation while an input is incomplete. Keep the last
 * checkpoint, report the failure, and never claim that the draft was saved. */
export async function saveImageGenerationDraft({ store, draft, expectedRevision, writeInputs }: {
  store: ImageGenerationStoreAccess, draft: ImageGenerationSessionDraft, expectedRevision: number | undefined, writeInputs: () => Promise<void>,
}): Promise<void> {
  const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: draft.sessionId }) });
  const prepared = definition.draft.prepareWrite({ value: draft });
  const next = prepared.snapshot.value;
  const binaryIds = [
    ...(next.request.imageInputs.initImage ? [next.request.imageInputs.initImage.binaryObjectId] : []),
    ...next.request.imageInputs.referenceImages.map(image => image.binaryObjectId),
  ];
  assertImageGenerationPathIds({ ids: binaryIds });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: next.sessionId });
      const io = imageGenerationIo({ directory: session, path: definition.path });
      const current = await definition.draft.read({ io });
      assertImageGenerationReplacement({ current, next: prepared.snapshot, expectedRevision });
      await assertImageGenerationBinariesNotDeleted({ directory, ids: binaryIds });
      await writeInputs();
      await prepared.write({ io });
    },
  });
}

/** writeInputs publishes immutable BinaryObjects using a captured provider.
 * It must not call a lock-taking storageService method recursively. */
export async function createImageGenerationRun({ store, run, writeInputs }: { store: ImageGenerationStoreAccess, run: ImageGenerationRun, writeInputs: () => Promise<void> }): Promise<void> {
  const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: run.sessionId }) }).runs;
  const requested = definition.prepareWrite({ value: run }).snapshot.value;
  assertImageGenerationPathIds({
    ids: [
      requested.id, requested.sessionId, ...(requested.operationId === undefined ? [] : [requested.operationId]),
      ...requested.sources.flatMap(source => [source.sessionId, source.assetId]),
      ...(requested.request.imageInputs.initImage ? [requested.request.imageInputs.initImage.binaryObjectId] : []),
      ...requested.request.imageInputs.referenceImages.map(image => image.binaryObjectId),
    ],
  });
  const next = { ...requested, acceptedOrder: undefined };
  if (next.revision !== 0 || next.execution.type !== 'queued') {
    throw new Error('New Image Generation runs must be queued at revision zero.');
  }
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const sessionDirectory = await requireSession({ directory, sessionId: next.sessionId });
      const session = await (await imageGenerationSessionTable({ directory, create: false })).load({ id: next.sessionId });
      if (!session) {
        throw new Error('Image Generation session does not exist.');
      }
      switch (session.state) {
      case 'active': break;
      case 'archived': throw new Error('Cannot generate into an archived session.');
      case 'deleting': case 'deleted': throw new Error('The session has been deleted.');
      default: {
        const exhaustive: never = session.state;
        throw new Error(String(exhaustive));
      }
      }
      for (const source of next.sources) {
        const origin = await requireSession({ directory, sessionId: source.sessionId });
        const asset = await (await imageGenerationAssetTable({ directory: origin, sessionId: source.sessionId, create: false })).load({ id: source.assetId });
        if (!asset) {
          throw new Error('Image Generation lineage source does not exist.');
        }
        const outputs = new Set([asset.result.binaryObjectId, ...asset.previews.map(preview => preview.binaryObjectId)]);
        // Reusing settings is not the same as feeding image bytes to the model.
        // An image-input edge must describe an actual input in this request.
        switch (source.role) {
        case 'settings': break;
        case 'initial-image':
          if (!next.request.imageInputs.initImage || !outputs.has(next.request.imageInputs.initImage.binaryObjectId)) {
            throw new Error('Lineage does not match the initial image input.');
          }
          break;
        case 'reference-image':
          if (!next.request.imageInputs.referenceImages.some(image => outputs.has(image.binaryObjectId))) {
            throw new Error('Lineage does not match any reference image input.');
          }
          break;
        default: {
          const exhaustive: never = source.role;
          throw new Error(String(exhaustive));
        }
        }
      }
      const table = await imageGenerationRunTable({ directory: sessionDirectory, sessionId: next.sessionId, create: true });
      const current = await table.read({ id: next.id });
      const retry = current === undefined ? undefined : table.prepareWrite({ value: { ...next, acceptedOrder: current.value.acceptedOrder } });
      if (retry !== undefined) {
        assertImageGenerationReplacement({ current, next: retry.snapshot, expectedRevision: undefined });
      }
      await table.preflightWrite({ id: next.id });
      await assertImageGenerationBinariesNotDeleted({ directory, ids: [...(next.request.imageInputs.initImage ? [next.request.imageInputs.initImage.binaryObjectId] : []), ...next.request.imageInputs.referenceImages.map(image => image.binaryObjectId)] });
      await writeInputs();
      const acceptedOrder = current ? undefined : await reserveImageGenerationActivity({ directory, run: { sessionId: next.sessionId, runId: next.id } });
      try {
        const prepared = retry ?? table.prepareWrite({ value: { ...next, acceptedOrder } });
        await prepared.write({ assertCurrent: ({ current, next }) => assertImageGenerationReplacement({ current, next, expectedRevision: undefined }), async beforeCommit() {} });
      } catch (error) {
      // No canonical record means there was no acceptance. A future attempt may
      // receive a new order. If publication succeeded but its acknowledgement
      // failed, keep the original durable reservation for recovery instead.
        try {
          if (!await table.load({ id: next.id })) {
            await finishImageGenerationActivity({ directory, sessionId: next.sessionId, runId: next.id });
          }
        } catch { /* Preserve the original publication error and recovery intent. */ }
        throw error;
      }
    },
  });
}

export async function loadImageGenerationRun({ store, sessionId, runId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId }): Promise<ImageGenerationRun | undefined> {
  const checkedSessionId = validateImageGenerationId({ id: sessionId }), id = validateImageGenerationId({ id: runId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: checkedSessionId });
      return (await imageGenerationRunTable({ directory: session, sessionId: checkedSessionId, create: false })).loadForEditing({ id });
    },
  });
}

export async function listImageGenerationRuns({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationReadResult<ImageGenerationRunSummary>> {
  const id = validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: id });
      const result = await (await imageGenerationRunTable({ directory: session, sessionId: id, create: false })).list();
      result.items.sort((a, b) => b.createdAt - a.createdAt || compareIds({ a: idToRaw({ id: a.id }), b: idToRaw({ id: b.id }) }));
      return result;
    },
  });
}

/** Call interruption recovery only after proving that no execution owner holds
 * the run. This function never infers interruption from local UI/Worker state. */
export async function updateImageGenerationRunExecution({ store, sessionId, runId, execution, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId, execution: ImageGenerationRunExecution, expectedRevision: number,
}): Promise<void> {
  const checkedSessionId = validateImageGenerationId({ id: sessionId }), id = validateImageGenerationId({ id: runId });
  const accepted = imageGenerationExecutionForStorage({ execution });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: checkedSessionId });
      const table = await imageGenerationRunTable({ directory: session, sessionId: checkedSessionId, create: false });
      const current = await table.read({ id });
      if (!current) {
        throw new Error('Image Generation run does not exist.');
      }
      if (accepted.type === 'running' && current.value.operationId !== undefined) {
        await requireImageGenerationOperationMembership({ directory: session, sessionId: checkedSessionId, operationId: current.value.operationId, runId: id });
      }
      const prepared = current.prepareChanges({ changes: { revision: expectedRevision + 1, execution: accepted } });
      const next = prepared.snapshot.value;
      assertImageGenerationReplacement({ current, next: prepared.snapshot, expectedRevision });
      if (!current.matches({ other: prepared.snapshot }) && !canTransitionImageGenerationRun({ from: current.value.execution.type, to: next.execution.type })) {
        throw new Error('Invalid Image Generation execution transition.');
      }
      switch (accepted.type) {
      case 'completed': {
        const assets = await (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).list();
        if (assets.warningCount) {
          throw new Error('Cannot confirm completion while asset metadata is unreadable.');
        }
        const outputs = assets.items.filter(asset => asset.runId === id);
        if (outputs.length !== next.seeds.length || new Set(outputs.map(asset => asset.index)).size !== next.seeds.length || outputs.some(asset => next.seeds[asset.index] !== asset.seed)) {
          throw new Error('Cannot complete a run before all planned outputs are committed.');
        }
        break;
      }
      case 'queued': case 'running': case 'cancelled': case 'failed': case 'interrupted': break;
      default: {
        const exhaustive: never = accepted;
        throw new Error(String(exhaustive));
      }
      }
      await prepared.write({
        assertCurrent({ current, next }) {
          assertImageGenerationReplacement({ current, next, expectedRevision });
        },
        async beforeCommit() {},
      });
    },
  });
}

/** Publish bytes first, metadata second, derived index last. A failed metadata
 * save may leave bytes, but never deliberately deletes shared BinaryObjects. */
export async function commitImageGenerationAsset({ store, asset, writeImages }: { store: ImageGenerationStoreAccess, asset: ImageGenerationAsset, writeImages: () => Promise<void> }): Promise<void> {
  const sessionDefinition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: asset.sessionId }) });
  const prepared = sessionDefinition.assets.prepareWrite({ value: asset });
  const next = prepared.snapshot.value;
  assertImageGenerationPathIds({
    ids: [
      next.id, next.sessionId, next.runId, next.result.binaryObjectId,
      ...next.previews.map(preview => preview.binaryObjectId),
    ],
  });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: next.sessionId });
      const run = await (await imageGenerationRunTable({ directory: session, sessionId: next.sessionId, create: false })).load({ id: next.runId });
      if (!run) {
        throw new Error('Image Generation run does not exist.');
      }
      const { table, write } = await prepared.open({ io: imageGenerationIo({ directory: session, path: sessionDefinition.path }), create: true });
      const previous = await table.load({ id: next.id });
      if (previous === undefined && run.execution.type !== 'running') {
        throw new Error('Only running jobs can publish new assets.');
      }
      if (run.seeds[next.index] !== next.seed || next.result.width !== run.request.parameters.width || next.result.height !== run.request.parameters.height) {
        throw new Error('Image Generation output does not match the accepted plan.');
      }
      const assets = await table.list();
      if (assets.warningCount) {
        throw new Error('Cannot publish an output while asset identities are unreadable.');
      }
      if (assets.items.some(item => item.runId === next.runId && item.index === next.index && item.id !== next.id)) {
        throw new Error('This run output slot already has an asset.');
      }
      await write({
        assertCurrent({ current, next }) {
          if (current && !current.matches({ other: next })) {
            throw new Error('Image Generation assets are immutable.');
          }
        },
        beforeCommit: async () => {
          await assertImageGenerationBinariesNotDeleted({ directory, ids: [next.result.binaryObjectId, ...next.previews.map(preview => preview.binaryObjectId)] });
          await writeImages();
        },
      });
    },
  });
}

export async function loadImageGenerationAsset({ store, sessionId, assetId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId }): Promise<ImageGenerationAsset | undefined> {
  const checkedSessionId = validateImageGenerationId({ id: sessionId }), id = validateImageGenerationId({ id: assetId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: checkedSessionId });
      return (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id });
    },
  });
}

export async function loadImageGenerationAssetAnnotations({ store, sessionId, assetId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId }): Promise<ImageGenerationAssetAnnotations | undefined> {
  const checkedSessionId = validateImageGenerationId({ id: sessionId }), id = validateImageGenerationId({ id: assetId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: checkedSessionId });
      if (!await (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id })) {
        return undefined;
      }
      const annotations = await (await imageGenerationAnnotationsTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id });
      return annotations ?? { assetId: id, sessionId: checkedSessionId, revision: 0, state: 'active', tags: [] };
    },
  });
}

export async function setImageGenerationAssetTags({ store, sessionId, assetId, tags, assignedAt, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId, tags: ImageGenerationTagReference[], assignedAt: number, expectedRevision: number,
}): Promise<void> {
  const checkedSessionId = validateImageGenerationId({ id: sessionId }), id = validateImageGenerationId({ id: assetId });
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(assignedAt);
  // This is a command limit, not a persisted-data constraint.
  if (tags.length > 256) {
    throw new Error('Too many Image Generation asset tags.');
  }
  const parsed = imageGenerationTagsForStorage({ tags });
  function tagKey({ tag }: { tag: ImageGenerationTagReference }): string {
    switch (tag.type) {
    case 'system': return 'system:favorite';
    case 'user': return `user:${idToRaw({ id: tag.tagId })}`;
    default: {
      const exhaustive: never = tag;
      throw new Error(String(exhaustive));
    }
    }
  }
  // Keep request order and leave any duplicate historical assignments readable.
  const requested = [...new Map(parsed.map(tag => [tagKey({ tag }), tag])).values()];
  await withImageGenerationStore({
    store,
    operation: async ({ directory, catalog }) => {
      const session = await requireSession({ directory, sessionId: checkedSessionId });
      if (!await (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id })) {
        throw new Error('Image Generation asset does not exist.');
      }
      const table = await imageGenerationAnnotationsTable({ directory: session, sessionId: checkedSessionId, create: true });
      const empty = table.prepareWrite({ value: { assetId: id, sessionId: checkedSessionId, revision: 0, state: 'active', tags: [] } }).snapshot;
      const snapshot = await table.read({ id }) ?? empty;
      const current = snapshot.value;
      if (current.state === 'deleting' || current.state === 'deleted') {
        throw new Error('Deleted images cannot be edited.');
      }
      const assignments = requested.map(tag => {
        const previous = current.tags.find(item => tagKey({ tag: item.tag }) === tagKey({ tag }));
        switch (tag.type) {
        case 'system': break;
        case 'user': {
          const definition = catalog.value.tags.find(definition => definition.id === tag.tagId);
          if (!definition || definition.state === 'archived' && !previous) {
            throw new Error('Cannot assign an unknown or archived user tag.');
          }
          break;
        }
        default: {
          const exhaustive: never = tag;
          throw new Error(String(exhaustive));
        }
        }
        return { tag, assignedAt: previous?.assignedAt ?? assignedAt };
      });
      const prepared = table.prepareWrite({ value: { assetId: id, sessionId: checkedSessionId, revision: expectedRevision + 1, state: current.state, tags: assignments } });
      assertImageGenerationReplacement({ current: snapshot, next: prepared.snapshot, expectedRevision });
      await prepared.write({
        assertCurrent({ current, next }) {
          assertImageGenerationReplacement({ current: current ?? empty, next, expectedRevision });
        },
        async beforeCommit() {},
      });
    },
  });
}

function compareIds({ a, b }: { a: string, b: string }): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Return one consistent, validated snapshot. Filtering, text normalization,
 * tag matching and pagination belong to the Image Generation feature, not storage. */
export async function readImageGenerationSessionIndex({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<{
  assets: ImageGenerationReadResult<ImageGenerationAssetSummary>,
  annotations: ImageGenerationReadResult<ImageGenerationAssetAnnotations>,
  runs: ImageGenerationReadResult<ImageGenerationRunSummary>,
}> {
  const id = validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: id });
      const assets = await (await imageGenerationAssetTable({ directory: session, sessionId: id, create: false })).list();
      const annotations = await (await imageGenerationAnnotationsTable({ directory: session, sessionId: id, create: false })).list();
      const runs = await (await imageGenerationRunTable({ directory: session, sessionId: id, create: false })).list();
      return { assets, annotations, runs };
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
