import { idToRaw, toBinaryObjectId, type BinaryObjectId, type ImageGenerationOperationId, type ImageGenerationSessionId } from '@/01-models/ids';
import { withImageGenerationStore, type ImageGenerationStoreAccess } from './image-generation/context';
import { imageGenerationRawIdSchema } from './image-generation/files';
import { imageGenerationAnnotationsTable, imageGenerationAssetTable, imageGenerationRunTable, imageGenerationSessionDirectory } from './image-generation/tables';
import { imageGenerationOperationTable } from './image-generation/operations';
import { readImageGenerationBinaryDeletion } from './image-generation/deletions';
import type { ExperimentalImageGenerationAssetDto, ExperimentalImageGenerationRunDto } from '@/00-storage/00-dto/experimental-image-generation.dto';

export type ImageGenerationResultExportSnapshot = { manifest: Blob, images: { path: string, blob: Blob }[] };
export type ImageGenerationResultFileReference = { id: BinaryObjectId, base: string, output: { filename: string | undefined } };

/** Explicit allowlists, not object spreads of stored requests. Model locators,
 * peer identities, arbitrary native arguments and error messages are not public
 * result metadata. Prompts are intentionally included in this user-made export. */
function publicRequest({ run }: { run: ExperimentalImageGenerationRunDto }) {
  const p = run.request.parameters;
  const execution = (() => {
    const state = run.execution;
    switch (state.type) {
    case 'queued': return { type: state.type };
    case 'running': return { type: state.type, startedAt: state.startedAt };
    case 'completed': case 'failed': case 'cancelled': case 'interrupted': return { type: state.type, finishedAt: state.finishedAt };
    default: {
      const exhaustive: never = state;
      throw new Error(String(exhaustive));
    }
    }
  })();
  return {
    runId: run.id,
    parameters: {
      prompt: p.prompt,
      negativePrompt: p.negativePrompt,
      width: p.width,
      height: p.height,
      steps: p.steps,
      guidance: p.guidance,
      seed: p.seed,
      sampler: p.sampler,
      scheduler: p.scheduler,
      distilledGuidance: p.distilledGuidance,
      vaeTiling: p.vaeTiling,
      vaeTileSize: p.vaeTileSize,
      flashAttention: p.flashAttention,
      bf16WeightType: p.bf16WeightType,
      qwenVaePolicy: p.qwenVaePolicy,
      conditioningCacheSize: p.conditioningCacheSize,
    },
    seeds: [...run.seeds],
    execution,
    models: run.request.models.map(model => ({ slot: model.slot, name: model.file.name.split(/[\\/]/u).pop() ?? '' })),
    loras: run.request.loras.map(lora => ({ name: lora.file.name.split(/[\\/]/u).pop() ?? '', strength: lora.strength })),
  };
}

export async function collectImageGenerationResultsMetadata({ store, sessionId, operationId, exportedAt }: {
  store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, operationId: ImageGenerationOperationId, exportedAt: number,
}) {
  const sessionRaw = imageGenerationRawIdSchema.parse(idToRaw({ id: sessionId }));
  const operationRaw = imageGenerationRawIdSchema.parse(idToRaw({ id: operationId }));
  return withImageGenerationStore({
    store,
    operation: async ({ directory }) => {
      const location = await imageGenerationSessionDirectory({ directory, sessionId: sessionRaw });
      if (!location) {
        throw new Error('The generation session no longer exists.');
      }
      const runTable = await imageGenerationRunTable({ directory: location, sessionId: sessionRaw, create: false });
      const parent = await (await imageGenerationOperationTable({ directory: location, sessionId: sessionRaw, create: false })).load({ id: operationRaw });
      const legacy = parent ? undefined : await runTable.load({ id: operationRaw });
      if (!parent && (!legacy || legacy.operationId !== undefined)) {
        throw new Error('The generation operation is missing or incomplete.');
      }
      const runIds = parent?.runIds ?? [legacy!.id];
      const runs: ExperimentalImageGenerationRunDto[] = [];
      for (const id of runIds) {
        const run = await runTable.load({ id });
        if (!run || (parent ? run.operationId !== parent.id : run.operationId !== undefined)) {
          throw new Error('A request does not belong to this generation operation.');
        }
        runs.push(run);
      }
      const assetTable = await imageGenerationAssetTable({ directory: location, sessionId: sessionRaw, create: false });
      const assetList = await assetTable.list();
      if (assetList.warningCount) {
        throw new Error('Image metadata is unreadable. Preserve the raw storage before exporting.');
      }
      const annotations = await imageGenerationAnnotationsTable({ directory: location, sessionId: sessionRaw, create: false });
      const byRun = new Map(runs.map(run => [run.id, [] as ExperimentalImageGenerationAssetDto[]]));
      const slots = new Set<string>();
      for (const summary of assetList.items) {
      // Canonical records, not a derived index, decide ZIP membership.
        const asset = await assetTable.load({ id: summary.id });
        if (!asset) {
          throw new Error('An image record disappeared during export.');
        }
        const target = byRun.get(asset.runId);
        if (!target) {
          continue;
        }
        const run = runs.find(run => run.id === asset.runId)!;
        const key = `${asset.runId}:${asset.index}`;
        if (!Number.isSafeInteger(asset.index) || run.seeds[asset.index] !== asset.seed || slots.has(key) || asset.result.width !== run.request.parameters.width || asset.result.height !== run.request.parameters.height) {
          throw new Error('An output does not match its unique planned seed.');
        }
        slots.add(key);
        target.push(asset);
      }
      const files: ImageGenerationResultFileReference[] = [];
      const requests = [];
      for (const [requestIndex, run] of runs.entries()) {
        const outputs = [];
        for (const asset of byRun.get(run.id)!.sort((a, b) => a.index - b.index)) {
          const annotation = await annotations.load({ id: asset.id });
          const annotationState = annotation?.state;
          switch (annotationState) {
          case 'deleting': throw new Error('Finish pending image deletion before exporting results.');
          case undefined: case 'active': case 'archived': case 'deleted': break;
          default: {
            const exhaustive: never = annotationState;
            throw new Error(String(exhaustive));
          }
          }
          const deleted = annotation?.state === 'deleted' || !!await readImageGenerationBinaryDeletion({ directory, id: asset.result.binaryObjectId });
          const confirmed = asset.result.confirmation !== 'unconfirmed';
          const output = {
            assetId: asset.id,
            index: asset.index,
            seed: asset.seed,
            width: asset.result.width,
            height: asset.result.height,
            status: deleted ? 'deleted' : confirmed ? 'included' : 'unconfirmed',
            filename: undefined as string | undefined,
            resolvedParameters: asset.result.resolvedParameters,
          };
          outputs.push(output);
          if (!deleted && confirmed) {
            files.push({ id: toBinaryObjectId({ raw: imageGenerationRawIdSchema.parse(asset.result.binaryObjectId) }), base: `images/${String(requestIndex + 1).padStart(3, '0')}/${String(asset.index + 1).padStart(2, '0')}`, output });
          }
        }
        requests.push({ index: requestIndex, ...publicRequest({ run }), outputs });
      }
      return {
        manifest: { version: 1, operationId: operationRaw, sessionId: sessionRaw, createdAt: parent?.createdAt ?? legacy!.createdAt, exportedAt, requests },
        files,
      };
    },
  });
}

export const TEST_ONLY = {
};
