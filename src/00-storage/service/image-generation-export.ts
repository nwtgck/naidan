import { opfsFormat } from '@/00-format/01-layout/layout';
import { validateImageGenerationId } from '@/00-format/image-generation-record';
import { imageGenerationOperationTable } from './image-generation/operations';
import { idToRaw, toBinaryObjectId, type BinaryObjectId, type ImageGenerationSessionId, type ImageGenerationTagId } from '@/01-models/ids';
import { readImageGenerationBinaryDeletion } from './image-generation/deletions';
import { withImageGenerationStoreForExport, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationIo } from './image-generation/files';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory } from './image-generation/tables';
import type { ExperimentalImageGenerationRequestDto } from '@/00-format/00-dto/experimental-image-generation.dto';

export type ImageGenerationExportFile = { path: string, blob: Blob };
export type ImageGenerationExportSnapshot = { metadata: ImageGenerationExportFile[], binaries: { id: BinaryObjectId, blob: Blob }[] };

function archiveRecordPath({ folder, rawId }: { folder: string, rawId: string }): string {
  return `${folder}/${rawId.slice(-2).toLowerCase()}/${rawId}.json`;
}

/** Capture disk-backed Files while the provider lock protects their contents. */
export async function collectImageGenerationSessionMetadata({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<{ metadata: ImageGenerationExportFile[], binaryObjectIds: BinaryObjectId[] }> {
  validateImageGenerationId({ id: sessionId });
  return withImageGenerationStoreForExport({
    store,
    operation: async ({ directory, catalog }) => {
      const location = await imageGenerationSessionDirectory({ directory, sessionId, requireLive: false });
      if (!location) {
        throw new Error('The session to export no longer exists.');
      }
      const definition = opfsFormat.storage.experimental.imageGeneration.sessions.root({ rawId: idToRaw({ id: sessionId }) });
      const io = imageGenerationIo({ directory: location, path: definition.path });
      const session = await opfsFormat.storage.experimental.imageGeneration.sessions.readForExport({ id: sessionId, io });
      if (!session || session.state === 'deleting' || session.state === 'deleted') {
        throw new Error('The session to export no longer exists.');
      }
      const metadata: ImageGenerationExportFile[] = [];
      const ids = new Set<string>(), tags = new Set<ImageGenerationTagId>();
      function inputs({ request }: { request: Pick<ExperimentalImageGenerationRequestDto, 'imageInputs'> }): void {
        if (request.imageInputs.initImage) {
          ids.add(request.imageInputs.initImage.binaryObjectId);
        }
        for (const image of request.imageInputs.referenceImages) {
          ids.add(image.binaryObjectId);
        }
      }
      metadata.push({ path: 'session.json', blob: new Blob([JSON.stringify({ ...session.dto, translation: undefined }, undefined, 2)], { type: 'application/json' }) });
      const draft = await definition.draft.captureForExport({ io });
      if (draft !== undefined) {
        inputs({ request: draft.dto.request });
        metadata.push({ path: 'draft.json', blob: draft.blob });
      }
      const composition = await definition.compositionDraft.captureForExport({ io });
      if (composition !== undefined) {
        metadata.push({ path: 'composition-draft.json', blob: composition.blob });
      }
      const operations = await imageGenerationOperationTable({ directory: location, sessionId, create: false });
      const operationList = await operations.list();
      if (operationList.warningCount) {
        throw new Error('Some generation operations cannot be exported safely. Preserve the raw OPFS directory.');
      }
      for (const operation of operationList.items) {
        const blob = await definition.operations.openFileForExport({ id: operation.id, io });
        if (!blob) {
          throw new Error('Operation metadata disappeared during export.');
        }
        metadata.push({ path: archiveRecordPath({ folder: 'operations', rawId: idToRaw({ id: operation.id }) }), blob });
      }
      const runTable = await imageGenerationRunTable({ directory: location, sessionId, create: false });
      const runList = await runTable.list();
      if (runList.warningCount) {
        throw new Error('Some run metadata cannot be exported safely. Preserve the raw OPFS directory.');
      }
      const plans = new Map<string, string[]>();
      for (const summary of runList.items) {
        const run = await definition.runs.captureForExport({ id: summary.id, io });
        if (!run) {
          throw new Error('Run metadata disappeared during export.');
        }
        plans.set(run.dto.id, run.dto.seeds);
        inputs({ request: run.dto.request });
        metadata.push({ path: archiveRecordPath({ folder: 'runs', rawId: run.dto.id }), blob: run.blob });
      }
      const assetTable = await imageGenerationAssetTable({ directory: location, sessionId, create: false });
      const assetList = await assetTable.list();
      if (assetList.warningCount) {
        throw new Error('Some asset metadata cannot be exported safely. Preserve the raw OPFS directory.');
      }
      for (const summary of assetList.items) {
        const asset = await definition.assets.captureForExport({ id: summary.id, io });
        if (!asset || plans.get(asset.dto.runId)?.[asset.dto.index] !== asset.dto.seed) {
          throw new Error('An image does not match its originating run. Preserve the raw OPFS directory.');
        }
        ids.add(asset.dto.result.binaryObjectId);
        for (const preview of asset.dto.previews) {
          ids.add(preview.binaryObjectId);
        }
        metadata.push({ path: archiveRecordPath({ folder: 'assets', rawId: asset.dto.id }), blob: asset.blob });
      }
      const annotations = await imageGenerationAnnotationsTable({ directory: location, sessionId, create: false });
      const annotationList = await annotations.list();
      if (annotationList.warningCount) {
        throw new Error('Some tag metadata cannot be exported safely. Preserve the raw OPFS directory.');
      }
      for (const annotation of annotationList.items) {
        switch (annotation.state) {
        case 'deleting': throw new Error('Finish the pending image deletions before exporting this session.');
        case 'active': case 'archived': case 'deleted': break;
        default: {
          const exhaustive: never = annotation.state;
          throw new Error(String(exhaustive));
        }
        }
        for (const assignment of annotation.tags) {
          switch (assignment.tag.type) {
          case 'user': tags.add(assignment.tag.tagId);
            break;
          case 'system': break;
          default: {
            const exhaustive: never = assignment.tag;
            throw new Error(String(exhaustive));
          }
          }
        }
        const blob = await definition.annotations.openFileForExport({ id: annotation.assetId, io });
        if (!blob) {
          throw new Error('Tag metadata disappeared during export.');
        }
        metadata.push({ path: archiveRecordPath({ folder: 'annotations', rawId: idToRaw({ id: annotation.assetId }) }), blob });
      }
      // Other sessions' tag names are not leaked through a session-only export.
      const selectedTags = new Set([...tags].map(id => idToRaw({ id })));
      metadata.push({ path: 'catalog.json', blob: new Blob([JSON.stringify({ ...catalog, preferences: { ...catalog.preferences, translation: undefined }, tags: catalog.tags.filter(tag => selectedTags.has(tag.id)) }, undefined, 2)], { type: 'application/json' }) });
      const binaryObjectIds: BinaryObjectId[] = [];
      for (const raw of ids) {
        const id = toBinaryObjectId({ raw });
        const marker = await readImageGenerationBinaryDeletion({ directory, id });
        if (marker) {
          metadata.push({ path: `deleted-binaries/${raw}.json`, blob: marker });
        } else {
          binaryObjectIds.push(id);
        }
      }
      return { metadata, binaryObjectIds };
    },
  });
}

export const TEST_ONLY = {
};
