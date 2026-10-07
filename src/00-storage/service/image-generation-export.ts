import { idToRaw, toBinaryObjectId, type BinaryObjectId, type ImageGenerationSessionId } from '@/01-models/ids';
import { ExperimentalImageGenerationDraftSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { readImageGenerationBinaryDeletion } from './image-generation/deletions';
import { withImageGenerationStore, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationRawIdSchema, readImageGenerationText } from './image-generation/files';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory, imageGenerationSessionTable } from './image-generation/tables';
import type { ExperimentalImageGenerationRequestDto } from '@/00-storage/00-dto/experimental-image-generation.dto';

export type ImageGenerationExportFile = { path: string, blob: Blob };
export type ImageGenerationExportSnapshot = { metadata: ImageGenerationExportFile[], binaries: { id: BinaryObjectId, blob: Blob }[] };

/** The storage service captures matching binary Files under its provider lock.
 * Files are retained as disk-backed snapshots, not accumulated byte buffers.
 * Unknown/corrupt records fail explicitly; use raw OPFS export to preserve them. */
export async function collectImageGenerationSessionMetadata({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<{ metadata: ImageGenerationExportFile[], binaryObjectIds: BinaryObjectId[] }> {
  const id = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory, catalog }) => {
    const session = await (await imageGenerationSessionTable({ directory, create: false })).load({ id });
    const location = await imageGenerationSessionDirectory({ directory, sessionId: id });
    if (!session || !location) throw new Error('The session to export no longer exists.');
    const metadata: ImageGenerationExportFile[] = [];
    const ids = new Set<string>(), tags = new Set<string>();
    async function retain({ path }: { path: string }): Promise<void> {
      const parts = path.split('/');
      const name = parts.pop();
      if (!name) throw new Error('Invalid export metadata path.');
      let parent = location!;
      for (const part of parts) parent = await parent.getDirectoryHandle(part);
      const blob = await (await parent.getFileHandle(name)).getFile();
      metadata.push({ path, blob });
    }
    function inputs({ request }: { request: Pick<ExperimentalImageGenerationRequestDto, 'imageInputs'> }): void {
      if (request.imageInputs.initImage) ids.add(request.imageInputs.initImage.binaryObjectId);
      for (const image of request.imageInputs.referenceImages) ids.add(image.binaryObjectId);
    }
    metadata.push({ path: 'session.json', blob: new Blob([JSON.stringify({ ...session, translation: undefined }, undefined, 2)], { type: 'application/json' }) });
    const draftText = await readImageGenerationText({ directory: location, name: 'draft.json' });
    if (draftText !== undefined) {
      const draft = ExperimentalImageGenerationDraftSchemaDto.parse(JSON.parse(draftText));
      if (draft.sessionId !== id) throw new Error('The draft belongs to another session.');
      inputs({ request: draft.request }); await retain({ path: 'draft.json' });
    }
    const runTable = await imageGenerationRunTable({ directory: location, sessionId: id, create: false });
    const runList = await runTable.list();
    if (runList.warningCount) throw new Error('Some run metadata cannot be exported safely. Preserve the raw OPFS directory.');
    const plans = new Map<string, string[]>();
    for (const summary of runList.items) {
      const run = await runTable.load({ id: summary.id });
      if (!run) throw new Error('Run metadata disappeared during export.');
      plans.set(run.id, run.seeds); inputs({ request: run.request });
      await retain({ path: `runs/${run.id.slice(-2).toLowerCase()}/${run.id}.json` });
    }
    const assetTable = await imageGenerationAssetTable({ directory: location, sessionId: id, create: false });
    const assetList = await assetTable.list();
    if (assetList.warningCount) throw new Error('Some asset metadata cannot be exported safely. Preserve the raw OPFS directory.');
    for (const summary of assetList.items) {
      const asset = await assetTable.load({ id: summary.id });
      if (!asset || plans.get(asset.runId)?.[asset.index] !== asset.seed) throw new Error('An image does not match its originating run. Preserve the raw OPFS directory.');
      ids.add(asset.result.binaryObjectId);
      for (const preview of asset.previews) ids.add(preview.binaryObjectId);
      await retain({ path: `assets/${asset.id.slice(-2).toLowerCase()}/${asset.id}.json` });
    }
    const annotations = await imageGenerationAnnotationsTable({ directory: location, sessionId: id, create: false });
    const annotationList = await annotations.list();
    if (annotationList.warningCount) throw new Error('Some tag metadata cannot be exported safely. Preserve the raw OPFS directory.');
    for (const annotation of annotationList.items) {
      switch (annotation.state) {
      case 'deleting': throw new Error('Finish the pending image deletions before exporting this session.');
      case 'active': case 'archived': case 'deleted': break;
      default: { const exhaustive: never = annotation.state; throw new Error(String(exhaustive)); }
      }
      for (const assignment of annotation.tags) {
        switch (assignment.tag.type) {
        case 'user': tags.add(assignment.tag.tagId); break;
        case 'system': break;
        default: { const exhaustive: never = assignment.tag; throw new Error(String(exhaustive)); }
        }
      }
      await retain({ path: `annotations/${annotation.assetId.slice(-2).toLowerCase()}/${annotation.assetId}.json` });
    }
    // Other sessions' tag names are not leaked through a session-only export.
    metadata.push({ path: 'catalog.json', blob: new Blob([JSON.stringify({ ...catalog, preferences: { ...catalog.preferences, translation: undefined }, tags: catalog.tags.filter(tag => tags.has(tag.id)) }, undefined, 2)], { type: 'application/json' }) });
    const binaryObjectIds: BinaryObjectId[] = [];
    for (const raw of ids) {
      const marker = await readImageGenerationBinaryDeletion({ directory, id: raw });
      if (marker) metadata.push({ path: `deleted-binaries/${raw}.json`, blob: marker });
      else binaryObjectIds.push(toBinaryObjectId({ raw }));
    }
    return { metadata, binaryObjectIds };
  },
  });
}
export const TEST_ONLY = {
};
