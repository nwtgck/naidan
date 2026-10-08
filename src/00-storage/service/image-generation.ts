import { applyImageGenerationActivity, finishImageGenerationActivity, recoverImageGenerationActivities, reserveImageGenerationActivity } from './image-generation/activity';
import { compareImageGenerationSessions } from '@/01-models/image-generation';
import { stringifyStorageDto } from './serialize';
import { assertImageGenerationBinariesNotDeleted } from './image-generation/deletions';
import type { ImageGenerationSessionDraft } from '@/01-models/image-generation';
import { ExperimentalImageGenerationDraftSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationDraftToDomain, imageGenerationDraftToDto } from '@/00-storage/mapper/image-generation';
import { z } from 'zod';
import { idToRaw, type ImageGenerationAssetId, type ImageGenerationRunId, type ImageGenerationSessionId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { canTransitionImageGenerationRun, type ImageGenerationAsset, type ImageGenerationAssetAnnotations, type ImageGenerationAssetSummary, type ImageGenerationCatalog, type ImageGenerationReadResult, type ImageGenerationRun, type ImageGenerationRunExecution, type ImageGenerationRunSummary, type ImageGenerationSession, type ImageGenerationTagReference } from '@/01-models/image-generation';
import {
  ExperimentalImageGenerationCatalogSchemaDto, ExperimentalImageGenerationSessionSchemaDto, ExperimentalImageGenerationRunSchemaDto,
  ExperimentalImageGenerationAssetSchemaDto, ExperimentalImageGenerationAssetAnnotationsSchemaDto, ExperimentalImageGenerationTagReferenceSchemaDto,
  ExperimentalImageGenerationRunExecutionSchemaDto,
} from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationAnnotationsToDomain, imageGenerationAssetSummaryToDomain, imageGenerationAssetToDomain, imageGenerationAssetToDto, imageGenerationCatalogToDomain, imageGenerationCatalogToDto, imageGenerationRunSummaryToDomain, imageGenerationRunToDomain, imageGenerationRunToDto, imageGenerationSessionToDomain, imageGenerationSessionToDto, imageGenerationTagReferenceToDto } from '@/00-storage/mapper/image-generation';
import { assertImageGenerationReplacement, openImageGenerationCatalogDto, withImageGenerationStore, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationRawIdSchema, imageGenerationIsNotFound, readImageGenerationText, writeImageGenerationText } from './image-generation/files';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory, imageGenerationSessionTable } from './image-generation/tables';

export type { ImageGenerationStoreAccess } from './image-generation/context';

/** No directory is created during an ordinary read-only visit. */
export async function openImageGenerationStore({ storageType, creation }: { storageType: StorageType, creation: 'allow' | 'forbid' }): Promise<ImageGenerationCatalog | undefined> {
  const dto = await openImageGenerationCatalogDto({ storageType, creation });
  return dto && imageGenerationCatalogToDomain({ dto });
}

export async function loadImageGenerationCatalog({ store }: { store: ImageGenerationStoreAccess }): Promise<ImageGenerationCatalog> {
  return withImageGenerationStore({ store, operation: async ({ catalog }) => imageGenerationCatalogToDomain({ dto: catalog }) });
}

/** Rename/archive tags by stable ID. Definitions are never physically removed. */
export async function saveImageGenerationCatalog({ store, catalog, expectedRevision }: { store: ImageGenerationStoreAccess, catalog: ImageGenerationCatalog, expectedRevision: number }): Promise<void> {
  const next = ExperimentalImageGenerationCatalogSchemaDto.parse(imageGenerationCatalogToDto({ catalog }));
  const serialized = stringifyStorageDto({ value: next, space: undefined });
  await withImageGenerationStore({
    store,
    operation: async ({ directory, catalog: current }) => {
      if (next.id !== current.id || next.createdAt !== current.createdAt) throw new Error('Image Generation catalog identity is immutable.');
      for (const previous of current.tags) {
        const tag = next.tags.find(tag => tag.id === previous.id);
        if (!tag) throw new Error('Archive tags instead of removing definitions referenced by images.');
        if (tag.createdAt !== previous.createdAt) throw new Error('Tag creation time is immutable.');
      }
      assertImageGenerationReplacement({ current, next, expectedRevision });
      if (stringifyStorageDto({ value: current, space: undefined }) !== serialized) await writeImageGenerationText({ directory, name: 'catalog.json', text: serialized });
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
        items: result.items.filter(dto => dto.state !== 'deleted').map(dto => imageGenerationSessionToDomain({ dto })).sort((a, b) => compareImageGenerationSessions({ a, b })),
      };
    },
  });
}
export async function loadImageGenerationSession({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationSession | undefined> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const dto = await (await imageGenerationSessionTable({ directory, create: false })).load({ id });
      return dto && dto.state !== 'deleted' && dto.state !== 'deleting' ? imageGenerationSessionToDomain({ dto }) : undefined;
    },
  });
}
export async function saveImageGenerationSession({ store, session, expectedRevision }: { store: ImageGenerationStoreAccess, session: ImageGenerationSession, expectedRevision: number | undefined }): Promise<ImageGenerationSession> {
  const requested = ExperimentalImageGenerationSessionSchemaDto.parse(imageGenerationSessionToDto({ session }));
  // Validate retained leaves before creating directories or reserving activity.
  stringifyStorageDto({ value: requested, space: undefined });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      if (requested.state === 'deleted' || requested.state === 'deleting') throw new Error('Use the explicit session deletion operation.');
      const table = await imageGenerationSessionTable({ directory, create: true });
      const current = await table.load({ id: requested.id });
      if (current?.state === 'deleted' || current?.state === 'deleting') throw new Error('The session has been deleted.');
      if (current && requested.createdAt !== current.createdAt) throw new Error('Session creation time is immutable.');
      // Callers cannot manufacture order, and retrying an acknowledged-lost save
      // must repair its index without reserving a newer position.
      const candidate = { ...requested, activityOrder: current?.activityOrder };
      assertImageGenerationReplacement({ current, next: candidate, expectedRevision });
      await table.preflightWrite({ id: requested.id });
      const next = current && stringifyStorageDto({ value: current, space: undefined }) === stringifyStorageDto({ value: candidate, space: undefined }) ? current
        : { ...candidate, activityOrder: await reserveImageGenerationActivity({ directory, run: undefined }) };
      await table.write({ record: next, assertCurrent: ({ current: latest }) => assertImageGenerationReplacement({ current: latest, next, expectedRevision }), async beforeCommit() {} });
      return imageGenerationSessionToDomain({ dto: next });
    },
  });
}

/** Merge an accepted run's durable order into current metadata. The underlying
 * journal also replays during session listing after page reload or tab exit. */
export async function recordImageGenerationSessionUse({ store, sessionId, runId }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId,
}): Promise<ImageGenerationSession> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  const runKey = imageGenerationRawIdSchema.parse(idToRaw({ id: runId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const result = await applyImageGenerationActivity({ directory, sessionId: id, runId: runKey });
      if (!result) throw new Error('The generation is not accepted or its session has been deleted.');
      return imageGenerationSessionToDomain({ dto: result });
    },
  });
}

/** Delete only session metadata. Stable BinaryObjects may be shared by chats and
 * intentionally survive. Keep a minimal tombstone so stale writers cannot revive
 * the session; cleanup can be retried after any interrupted directory removal. */
export async function deleteImageGenerationSession({ store, sessionId, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, expectedRevision: number,
}): Promise<void> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const table = await imageGenerationSessionTable({ directory, create: false });
      let current = await table.load({ id });
      if (!current) throw new Error('The session no longer exists.');
      switch (current.state) {
      case 'deleted': return;
      case 'deleting': break;
      case 'active': case 'archived': {
        if (current.revision !== expectedRevision) throw new Error('Image Generation revision conflict. Reload before deleting.');
        const next = {
          ...current,
          revision: current.revision + 1,
          updatedAt: Date.now(),
          state: 'deleting' as const,
          assistantChatId: undefined,
          translation: undefined,
        };
        await table.write({ record: next, assertCurrent: ({ current }) => assertImageGenerationReplacement({ current, next, expectedRevision }), async beforeCommit() {} });
        current = next;
        break;
      }
      default: { const exhaustive: never = current.state; throw new Error(String(exhaustive)); }
      }
      // Open the directory directly: ordinary readers intentionally reject tombstones.
      let location = directory;
      for (const name of ['sessions', id.slice(-2).toLowerCase(), id]) location = await location.getDirectoryHandle(name);
      const names: string[] = [];
      for await (const [name] of location.entries()) if (name !== 'session.json') names.push(name);
      for (const name of names) {
        try {
          await location.removeEntry(name, { recursive: true });
        } catch (error) {
          if (!imageGenerationIsNotFound({ error })) throw error;
        }
      }
      const next = { ...current, revision: current.revision + 1, updatedAt: Date.now(), state: 'deleted' as const, title: 'Deleted session' };
      const expected = current.revision;
      await table.write({ record: next, assertCurrent: ({ current }) => assertImageGenerationReplacement({ current, next, expectedRevision: expected }), async beforeCommit() {} });
    },
  });
}

async function requireSession({ directory, sessionId }: { directory: FileSystemDirectoryHandle, sessionId: string }): Promise<FileSystemDirectoryHandle> {
  const session = await imageGenerationSessionDirectory({ directory, sessionId });
  if (!session) throw new Error('Image Generation session does not exist.');
  return session;
}

export async function loadImageGenerationDraft({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationSessionDraft | undefined> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: id });
      const text = await readImageGenerationText({ directory: session, name: 'draft.json' });
      if (text === undefined) return undefined;
      const dto = ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(text));
      if (dto.sessionId !== id) throw new Error('Image Generation draft belongs to another session.');
      return imageGenerationDraftToDomain({ dto });
    },
  });
}

/** A checkpoint may fail validation while an input is incomplete. Keep the last
 * checkpoint, report the failure, and never claim that the draft was saved. */
export async function saveImageGenerationDraft({ store, draft, expectedRevision, writeInputs }: {
  store: ImageGenerationStoreAccess, draft: ImageGenerationSessionDraft, expectedRevision: number | undefined, writeInputs: () => Promise<void>,
}): Promise<void> {
  const next = ExperimentalImageGenerationDraftSchemaDto.parse(imageGenerationDraftToDto({ draft }));
  const serialized = stringifyStorageDto({ value: next, space: undefined });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: next.sessionId });
      const text = await readImageGenerationText({ directory: session, name: 'draft.json' });
      const current = text === undefined ? undefined : ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(text));
      if (current && current.sessionId !== next.sessionId) throw new Error('Image Generation draft identity mismatch.');
      assertImageGenerationReplacement({ current, next, expectedRevision });
      await assertImageGenerationBinariesNotDeleted({ directory, ids: [...(next.request.imageInputs.initImage ? [next.request.imageInputs.initImage.binaryObjectId] : []), ...next.request.imageInputs.referenceImages.map(image => image.binaryObjectId)] });
      await writeInputs();
      await writeImageGenerationText({ directory: session, name: 'draft.json', text: serialized });
    },
  });
}

/** writeInputs publishes immutable BinaryObjects using a captured provider.
 * It must not call a lock-taking storageService method recursively. */
export async function createImageGenerationRun({ store, run, writeInputs }: { store: ImageGenerationStoreAccess, run: ImageGenerationRun, writeInputs: () => Promise<void> }): Promise<void> {
  const requested = ExperimentalImageGenerationRunSchemaDto.parse(imageGenerationRunToDto({ run }));
  const next = { ...requested, acceptedOrder: undefined };
  if (next.revision !== 0 || next.execution.type !== 'queued') throw new Error('New Image Generation runs must be queued at revision zero.');
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const sessionDirectory = await requireSession({ directory, sessionId: next.sessionId });
      const session = await (await imageGenerationSessionTable({ directory, create: false })).load({ id: next.sessionId });
      if (!session) throw new Error('Image Generation session does not exist.');
      switch (session.state) {
      case 'active': break;
      case 'archived': throw new Error('Cannot generate into an archived session.');
      case 'deleting': case 'deleted': throw new Error('The session has been deleted.');
      default: { const exhaustive: never = session.state; throw new Error(String(exhaustive)); }
      }
      for (const source of next.sources) {
        const origin = await requireSession({ directory, sessionId: source.sessionId });
        const asset = await (await imageGenerationAssetTable({ directory: origin, sessionId: source.sessionId, create: false })).load({ id: source.assetId });
        if (!asset) throw new Error('Image Generation lineage source does not exist.');
        const outputs = new Set([asset.result.binaryObjectId, ...asset.previews.map(preview => preview.binaryObjectId)]);
        // Reusing settings is not the same as feeding image bytes to the model.
        // An image-input edge must describe an actual input in this request.
        switch (source.role) {
        case 'settings': break;
        case 'initial-image':
          if (!next.request.imageInputs.initImage || !outputs.has(next.request.imageInputs.initImage.binaryObjectId)) throw new Error('Lineage does not match the initial image input.');
          break;
        case 'reference-image':
          if (!next.request.imageInputs.referenceImages.some(image => outputs.has(image.binaryObjectId))) throw new Error('Lineage does not match any reference image input.');
          break;
        default: { const exhaustive: never = source.role; throw new Error(String(exhaustive)); }
        }
      }
      const table = await imageGenerationRunTable({ directory: sessionDirectory, sessionId: next.sessionId, create: true });
      const current = await table.load({ id: next.id });
      const candidate = { ...next, acceptedOrder: current?.acceptedOrder };
      assertImageGenerationReplacement({ current, next: candidate, expectedRevision: undefined });
      await table.preflightWrite({ id: next.id });
      await assertImageGenerationBinariesNotDeleted({ directory, ids: [...(next.request.imageInputs.initImage ? [next.request.imageInputs.initImage.binaryObjectId] : []), ...next.request.imageInputs.referenceImages.map(image => image.binaryObjectId)] });
      await writeInputs();
      const accepted = current ?? { ...candidate, acceptedOrder: await reserveImageGenerationActivity({ directory, run: { sessionId: next.sessionId, runId: next.id } }) };
      try {
        await table.write({ record: accepted, assertCurrent: ({ current: latest }) => assertImageGenerationReplacement({ current: latest, next: accepted, expectedRevision: undefined }), async beforeCommit() {} });
      } catch (error) {
      // No canonical record means there was no acceptance. A future attempt may
      // receive a new order. If publication succeeded but its acknowledgement
      // failed, keep the original durable reservation for recovery instead.
        try {
          if (!await table.load({ id: next.id })) await finishImageGenerationActivity({ directory, sessionId: next.sessionId, runId: next.id });
        } catch { /* Preserve the original publication error and recovery intent. */ }
        throw error;
      }
    },
  });
}
export async function loadImageGenerationRun({ store, sessionId, runId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId }): Promise<ImageGenerationRun | undefined> {
  const rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId })), id = imageGenerationRawIdSchema.parse(idToRaw({ id: runId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: rawSessionId });
      const dto = await (await imageGenerationRunTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id });
      return dto && imageGenerationRunToDomain({ dto });
    },
  });
}
export async function listImageGenerationRuns({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationReadResult<ImageGenerationRunSummary>> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: id });
      const result = await (await imageGenerationRunTable({ directory: session, sessionId: id, create: false })).list();
      result.items.sort((a, b) => b.createdAt - a.createdAt || compareIds({ a: a.id, b: b.id }));
      return { ...result, items: result.items.map(dto => imageGenerationRunSummaryToDomain({ dto })) };
    },
  });
}

/** Call interruption recovery only after proving that no execution owner holds
 * the run. This function never infers interruption from local UI/Worker state. */
export async function updateImageGenerationRunExecution({ store, sessionId, runId, execution, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId, execution: ImageGenerationRunExecution, expectedRevision: number,
}): Promise<void> {
  const rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId })), id = imageGenerationRawIdSchema.parse(idToRaw({ id: runId }));
  const accepted = ExperimentalImageGenerationRunExecutionSchemaDto.parse(execution);
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: rawSessionId });
      const table = await imageGenerationRunTable({ directory: session, sessionId: rawSessionId, create: false });
      const current = await table.load({ id });
      if (!current) throw new Error('Image Generation run does not exist.');
      const next = ExperimentalImageGenerationRunSchemaDto.parse({ ...current, revision: expectedRevision + 1, execution: accepted });
      assertImageGenerationReplacement({ current, next, expectedRevision });
      if (stringifyStorageDto({ value: current, space: undefined }) !== stringifyStorageDto({ value: next, space: undefined }) && !canTransitionImageGenerationRun({ from: current.execution.type, to: next.execution.type })) throw new Error('Invalid Image Generation execution transition.');
      switch (accepted.type) {
      case 'completed': {
        const assets = await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).list();
        if (assets.warningCount) throw new Error('Cannot confirm completion while asset metadata is unreadable.');
        const outputs = assets.items.filter(asset => asset.runId === id);
        if (outputs.length !== next.seeds.length || new Set(outputs.map(asset => asset.index)).size !== next.seeds.length || outputs.some(asset => next.seeds[asset.index] !== asset.seed)) {
          throw new Error('Cannot complete a run before all planned outputs are committed.');
        }
        break;
      }
      case 'queued': case 'running': case 'cancelled': case 'failed': case 'interrupted': break;
      default: { const exhaustive: never = accepted; throw new Error(String(exhaustive)); }
      }
      await table.write({
        record: next,
        assertCurrent({ current }) {
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
  const next = ExperimentalImageGenerationAssetSchemaDto.parse(imageGenerationAssetToDto({ asset }));
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: next.sessionId });
      const run = await (await imageGenerationRunTable({ directory: session, sessionId: next.sessionId, create: false })).load({ id: next.runId });
      if (!run) throw new Error('Image Generation run does not exist.');
      const table = await imageGenerationAssetTable({ directory: session, sessionId: next.sessionId, create: true });
      const previous = await table.load({ id: next.id });
      if (previous === undefined && run.execution.type !== 'running') throw new Error('Only running jobs can publish new assets.');
      if (run.seeds[next.index] !== next.seed || next.result.width !== run.request.parameters.width || next.result.height !== run.request.parameters.height) {
        throw new Error('Image Generation output does not match the accepted plan.');
      }
      const assets = await table.list();
      if (assets.warningCount) throw new Error('Cannot publish an output while asset identities are unreadable.');
      if (assets.items.some(item => item.runId === next.runId && item.index === next.index && item.id !== next.id)) throw new Error('This run output slot already has an asset.');
      await table.write({
        record: next,
        assertCurrent({ current }) {
          if (current && stringifyStorageDto({ value: current, space: undefined }) !== stringifyStorageDto({ value: next, space: undefined })) throw new Error('Image Generation assets are immutable.');
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
  const rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId })), id = imageGenerationRawIdSchema.parse(idToRaw({ id: assetId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: rawSessionId });
      const dto = await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id });
      return dto && imageGenerationAssetToDomain({ dto });
    },
  });
}

export async function loadImageGenerationAssetAnnotations({ store, sessionId, assetId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId }): Promise<ImageGenerationAssetAnnotations | undefined> {
  const rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId })), id = imageGenerationRawIdSchema.parse(idToRaw({ id: assetId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: rawSessionId });
      if (!await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id })) return undefined;
      const dto = await (await imageGenerationAnnotationsTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id });
      return imageGenerationAnnotationsToDomain({ dto: dto ?? { assetId: id, sessionId: rawSessionId, revision: 0, state: 'active' as const, tags: [] } });
    },
  });
}

export async function setImageGenerationAssetTags({ store, sessionId, assetId, tags, assignedAt, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId, tags: ImageGenerationTagReference[], assignedAt: number, expectedRevision: number,
}): Promise<void> {
  const rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId })), id = imageGenerationRawIdSchema.parse(idToRaw({ id: assetId }));
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(assignedAt);
  const requested = z.array(ExperimentalImageGenerationTagReferenceSchemaDto).max(256).parse(tags.map(tag => imageGenerationTagReferenceToDto({ tag })));
  await withImageGenerationStore({
    store,
    operation: async ({ directory, catalog }) => {
      const session = await requireSession({ directory, sessionId: rawSessionId });
      if (!await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id })) throw new Error('Image Generation asset does not exist.');
      const table = await imageGenerationAnnotationsTable({ directory: session, sessionId: rawSessionId, create: true });
      const current = await table.load({ id }) ?? { assetId: id, sessionId: rawSessionId, revision: 0, state: 'active' as const, tags: [] };
      if (current.state === 'deleting' || current.state === 'deleted') throw new Error('Deleted images cannot be edited.');
      const assignments = requested.map(tag => {
        const previous = current.tags.find(item => JSON.stringify(item.tag) === JSON.stringify(tag));
        switch (tag.type) {
        case 'system': break;
        case 'user': {
          const definition = catalog.tags.find(definition => definition.id === tag.tagId);
          if (!definition || definition.state === 'archived' && !previous) throw new Error('Cannot assign an unknown or archived user tag.');
          break;
        }
        default: { const exhaustive: never = tag; throw new Error(String(exhaustive)); }
        }
        return { tag, assignedAt: previous?.assignedAt ?? assignedAt };
      });
      const next = ExperimentalImageGenerationAssetAnnotationsSchemaDto.parse({ assetId: id, sessionId: rawSessionId, revision: expectedRevision + 1, state: current.state, tags: assignments });
      assertImageGenerationReplacement({ current, next, expectedRevision });
      await table.write({
        record: next,
        assertCurrent({ current }) {
          assertImageGenerationReplacement({ current: current ?? { assetId: id, sessionId: rawSessionId, revision: 0, state: 'active' as const, tags: [] }, next, expectedRevision });
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
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await requireSession({ directory, sessionId: id });
      const assets = await (await imageGenerationAssetTable({ directory: session, sessionId: id, create: false })).list();
      const annotations = await (await imageGenerationAnnotationsTable({ directory: session, sessionId: id, create: false })).list();
      const runs = await (await imageGenerationRunTable({ directory: session, sessionId: id, create: false })).list();
      return {
        assets: { ...assets, items: assets.items.map(dto => imageGenerationAssetSummaryToDomain({ dto })) },
        annotations: { ...annotations, items: annotations.items.map(dto => imageGenerationAnnotationsToDomain({ dto })) },
        runs: { ...runs, items: runs.items.map(dto => imageGenerationRunSummaryToDomain({ dto })) },
      };
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
