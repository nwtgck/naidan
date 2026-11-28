import { type BinaryObjectId, type ImageGenerationAssetId, type ImageGenerationRunId, type ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationAssetAnnotations } from '@/01-models/image-generation';
import { assertImageGenerationReplacement, withImageGenerationStore, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory } from './image-generation/tables';
import { validateImageGenerationId } from '@/00-format/image-generation-record';
import { markImageGenerationBinariesDeleted } from './image-generation/deletions';

async function sessionDirectory({ directory, sessionId }: { directory: FileSystemDirectoryHandle, sessionId: ImageGenerationSessionId }): Promise<FileSystemDirectoryHandle> {
  const session = await imageGenerationSessionDirectory({ directory, sessionId });
  if (!session) {
    throw new Error('Image Generation session does not exist.');
  }
  return session;
}

/** Resolve the whole persisted run, never just the gallery's loaded page. */
export async function listImageGenerationRunAssets({ store, sessionId, runId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, runId: ImageGenerationRunId }) {
  const checkedSessionId = validateImageGenerationId({ id: sessionId }), checkedRunId = validateImageGenerationId({ id: runId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await sessionDirectory({ directory, sessionId: checkedSessionId });
      const run = await (await imageGenerationRunTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id: checkedRunId });
      if (!run || run.execution.type === 'running' || run.execution.type === 'queued') {
        throw new Error('Wait for this run to finish before editing all its outputs.');
      }
      const assets = await (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).list();
      const annotations = await (await imageGenerationAnnotationsTable({ directory: session, sessionId: checkedSessionId, create: false })).list();
      if (assets.warningCount || annotations.warningCount) {
        throw new Error('Some image records are unreadable. Reload before editing the whole run.');
      }
      const byId = new Map(annotations.items.map(item => [item.assetId, item]));
      return assets.items.filter(item => item.runId === checkedRunId).map(asset => ({
        ...asset,
        annotations: byId.get(asset.id) ?? { assetId: asset.id, sessionId: checkedSessionId, revision: 0, state: 'active' as const, tags: [] },
      })).filter(item => item.annotations.state === 'active' || item.annotations.state === 'archived');
    },
  });
}

export async function setImageGenerationAssetState({ store, sessionId, assetId, state, expectedRevision }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: ImageGenerationAssetId, state: 'active' | 'archived', expectedRevision: number,
}): Promise<ImageGenerationAssetAnnotations> {
  const id = validateImageGenerationId({ id: assetId }), checkedSessionId = validateImageGenerationId({ id: sessionId });
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await sessionDirectory({ directory, sessionId: checkedSessionId });
      if (!await (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id })) {
        throw new Error('The saved image no longer exists.');
      }
      const table = await imageGenerationAnnotationsTable({ directory: session, sessionId: checkedSessionId, create: true });
      const snapshot = await table.read({ id }) ?? table.prepareWrite({ value: { assetId: id, sessionId: checkedSessionId, revision: 0, state: 'active', tags: [] } }).snapshot;
      const current = snapshot.value;
      if (current.state === 'deleting' || current.state === 'deleted') {
        throw new Error('A deleted image cannot be restored.');
      }
      const next = table.prepareWrite({ value: { ...current, revision: expectedRevision + 1, state } });
      assertImageGenerationReplacement({ current: snapshot, next: next.snapshot, expectedRevision });
      await next.write({ assertCurrent() {}, async beforeCommit() {} });
      return next.snapshot.value;
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
  const id = validateImageGenerationId({ id: assetId }), checkedSessionId = validateImageGenerationId({ id: sessionId });
  await withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const session = await sessionDirectory({ directory, sessionId: checkedSessionId });
      const asset = await (await imageGenerationAssetTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id });
      if (!asset) {
        throw new Error('The saved image no longer exists.');
      }
      const run = await (await imageGenerationRunTable({ directory: session, sessionId: checkedSessionId, create: false })).load({ id: asset.runId });
      if (!run || run.execution.type === 'running' || run.execution.type === 'queued') {
        throw new Error('Wait for this run to finish before permanently deleting its outputs.');
      }
      const table = await imageGenerationAnnotationsTable({ directory: session, sessionId: checkedSessionId, create: true });
      const snapshot = await table.read({ id }) ?? table.prepareWrite({ value: { assetId: id, sessionId: checkedSessionId, revision: 0, state: 'active', tags: [] } }).snapshot;
      let current = snapshot.value;
      switch (current.state) {
      case 'deleted': return;
      case 'deleting': break;
      case 'active': case 'archived': {
        const next = table.prepareWrite({ value: { ...current, state: 'deleting', revision: expectedRevision + 1 } });
        assertImageGenerationReplacement({ current: snapshot, next: next.snapshot, expectedRevision });
        await next.write({ assertCurrent() {}, async beforeCommit() {} });
        current = next.snapshot.value;
        break;
      }
      default: {
        const exhaustive: never = current.state;
        throw new Error(String(exhaustive));
      }
      }
      const ids = [...new Set([asset.result.binaryObjectId, ...asset.previews.map(image => image.binaryObjectId)])];
      await markImageGenerationBinariesDeleted({ directory, ids });
      for (const binaryObjectId of ids) {
        await removeBinary({ binaryObjectId });
      }
      const next = table.prepareWrite({ value: { ...current, state: 'deleted', tags: [], revision: current.revision + 1 } });
      await next.write({ assertCurrent() {}, async beforeCommit() {} });
    },
  });
}

export const TEST_ONLY = {
};
