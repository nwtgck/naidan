import { idToRaw, toBinaryObjectId, type BinaryObjectId, type ImageGenerationAssetId, type ImageGenerationRunId, type ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationAssetAnnotations } from '@/01-models/image-generation';
import { ExperimentalImageGenerationAssetAnnotationsSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationAnnotationsToDomain, imageGenerationAssetSummaryToDomain } from '@/00-storage/mapper/image-generation';
import { assertImageGenerationReplacement, withImageGenerationStore, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory } from './image-generation/tables';
import { imageGenerationRawIdSchema } from './image-generation/files';
import { markImageGenerationBinariesDeleted } from './image-generation/deletions';

async function sessionDirectory({ directory, sessionId }: { directory: FileSystemDirectoryHandle, sessionId: string }): Promise<FileSystemDirectoryHandle> {
  const session = await imageGenerationSessionDirectory({ directory, sessionId });
  if (!session) throw new Error('Image Generation session does not exist.');
  return session;
}

/** Resolve the whole persisted run, never just the gallery's loaded page. */
export async function listImageGenerationRunAssets({ store, sessionId, runId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId }) {
  const rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId })), rawRunId = imageGenerationRawIdSchema.parse(idToRaw({ id: runId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await sessionDirectory({ directory, sessionId: rawSessionId });
      const run = await (await imageGenerationRunTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id: rawRunId });
      if (!run || run.execution.type === 'running' || run.execution.type === 'queued') throw new Error('Wait for this run to finish before editing all its outputs.');
      const assets = await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).list();
      const annotations = await (await imageGenerationAnnotationsTable({ directory: session, sessionId: rawSessionId, create: false })).list();
      if (assets.warningCount || annotations.warningCount) throw new Error('Some image records are unreadable. Reload before editing the whole run.');
      const byId = new Map(annotations.items.map(item => [item.assetId, item]));
      return assets.items.filter(item => item.runId === rawRunId).map(dto => ({
        ...imageGenerationAssetSummaryToDomain({ dto }),
        annotations: imageGenerationAnnotationsToDomain({ dto: byId.get(dto.id) ?? { assetId: dto.id, sessionId: rawSessionId, revision: 0, state: 'active', tags: [] } }),
      })).filter(item => item.annotations.state === 'active' || item.annotations.state === 'archived');
    },
  });
}

export async function setImageGenerationAssetState({ store, sessionId, assetId, state, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId, state: 'active' | 'archived', expectedRevision: number,
}): Promise<ImageGenerationAssetAnnotations> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: assetId })), rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await sessionDirectory({ directory, sessionId: rawSessionId });
      if (!await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id })) throw new Error('The saved image no longer exists.');
      const table = await imageGenerationAnnotationsTable({ directory: session, sessionId: rawSessionId, create: true });
      const current = await table.load({ id }) ?? { assetId: id, sessionId: rawSessionId, revision: 0, state: 'active' as const, tags: [] };
      if (current.state === 'deleting' || current.state === 'deleted') throw new Error('A deleted image cannot be restored.');
      const next = ExperimentalImageGenerationAssetAnnotationsSchemaDto.parse({ ...current, revision: expectedRevision + 1, state });
      assertImageGenerationReplacement({ current, next, expectedRevision });
      await table.write({ record: next, assertCurrent() {}, async beforeCommit() {} });
      return imageGenerationAnnotationsToDomain({ dto: next });
    },
  });
}

/** Provider callback runs under metadata -> sync -> Workspace locks. Do not call
 * storageService recursively. Once deleting is durable, retries finish the same
 * irreversible operation; they never guess which bytes belonged to an image. */
export async function deleteImageGenerationAsset({ store, sessionId, assetId, expectedRevision, removeBinary }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId, expectedRevision: number,
  removeBinary: ({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) => Promise<void>,
}): Promise<void> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: assetId })), rawSessionId = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await sessionDirectory({ directory, sessionId: rawSessionId });
      const asset = await (await imageGenerationAssetTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id });
      if (!asset) throw new Error('The saved image no longer exists.');
      const run = await (await imageGenerationRunTable({ directory: session, sessionId: rawSessionId, create: false })).load({ id: asset.runId });
      if (!run || run.execution.type === 'running' || run.execution.type === 'queued') throw new Error('Wait for this run to finish before permanently deleting its outputs.');
      const table = await imageGenerationAnnotationsTable({ directory: session, sessionId: rawSessionId, create: true });
      let current = await table.load({ id }) ?? { assetId: id, sessionId: rawSessionId, revision: 0, state: 'active' as const, tags: [] };
      switch (current.state) {
      case 'deleted': return;
      case 'deleting': break;
      case 'active': case 'archived': {
        const next = ExperimentalImageGenerationAssetAnnotationsSchemaDto.parse({ ...current, state: 'deleting', revision: expectedRevision + 1 });
        assertImageGenerationReplacement({ current, next, expectedRevision });
        await table.write({ record: next, assertCurrent() {}, async beforeCommit() {} });
        current = next;
        break;
      }
      default: { const exhaustive: never = current.state; throw new Error(String(exhaustive)); }
      }
      const ids = [...new Set([asset.result.binaryObjectId, ...asset.previews.map(image => image.binaryObjectId)])];
      await markImageGenerationBinariesDeleted({ directory, ids });
      for (const raw of ids) await removeBinary({ binaryObjectId: toBinaryObjectId({ raw }) });
      const next = ExperimentalImageGenerationAssetAnnotationsSchemaDto.parse({ ...current, state: 'deleted', tags: [], revision: current.revision + 1 });
      await table.write({ record: next, assertCurrent() {}, async beforeCommit() {} });
    },
  });
}
export const TEST_ONLY = {
};
